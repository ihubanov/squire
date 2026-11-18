#!/usr/bin/env node
/**
 * Move every published version pin onto package.json's version.
 *
 * Runs from npm's `version` lifecycle (so a manual `npm version X.Y.Z`
 * produces a correct commit) and from the Release workflow before publishing
 * (so a release cannot ship a stale plugin pin). Idempotent: running it twice
 * changes nothing the second time.
 *
 * Files owned here:
 *   - server.json                               (MCP registry)
 *   - plugin/.mcp.json                          (plugin launches this pin)
 *   - plugin/.claude-plugin/plugin.json         (plugin version)
 *   - .claude-plugin/marketplace.json           (the version /plugin updates from)
 *
 * The plugin version is bumped by a patch when the plugin's own launch
 * configuration changes (the pin moves every release), so
 * `/plugin marketplace update squire` always sees a new version.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (relative) => join(root, relative);
const read = (relative) => JSON.parse(readFileSync(at(relative), 'utf8'));
const write = (relative, value) =>
  writeFileSync(at(relative), `${JSON.stringify(value, null, 2)}\n`);

const pkg = read('package.json');
const version = pkg.version;
const spec = `@sniffski/squire@${version}`;
const launcher = '${CLAUDE_PLUGIN_ROOT}/bin/squire-mcp.mjs';
const changed = [];

if (!existsSync(at('plugin/bin/squire-mcp.mjs'))) {
  throw new Error(
    'plugin/bin/squire-mcp.mjs is missing; the plugin pin would launch nothing'
  );
}

// 1. MCP registry manifest.
const serverJson = read('server.json');
const registryPkg = serverJson.packages?.[0];
if (
  serverJson.version !== version ||
  !registryPkg ||
  registryPkg.version !== version
) {
  serverJson.version = version;
  if (registryPkg) {
    registryPkg.version = version;
  }
  write('server.json', serverJson);
  changed.push('server.json');
}

// 2. Plugin MCP launch: the shim (which repairs a corrupt npx cache) plus
//    the exact pin. Old configs were `npx -y @sniffski/squire@<pin>`; the
//    shim adds `-y` itself, so drop those arguments when migrating.
const mcp = read('plugin/.mcp.json');
const server = mcp.mcpServers?.squire;
if (!server) {
  throw new Error('plugin/.mcp.json has no mcpServers.squire entry to sync');
}
const previousArgs = Array.isArray(server.args) ? server.args : [];
const previousLauncher = previousArgs[0];
const previousPin = previousArgs.find(
  (arg) => typeof arg === 'string' && arg.startsWith('@sniffski/squire@')
);
const extraArgs = previousArgs.filter(
  (arg) =>
    arg !== previousPin &&
    arg !== previousLauncher &&
    arg !== '-y' &&
    arg !== '--yes'
);
server.command = 'node';
server.args = [launcher, spec, ...extraArgs];
const pluginLaunchChanged =
  previousPin !== spec ||
  previousLauncher !== launcher ||
  previousArgs.length !== server.args.length;
if (JSON.stringify(read('plugin/.mcp.json')) !== JSON.stringify(mcp)) {
  write('plugin/.mcp.json', mcp);
  if (!changed.includes('plugin/.mcp.json')) {
    changed.push('plugin/.mcp.json');
  }
}

// 3. Plugin version: a moved pin is a plugin change. Bump a patch so
//    auto-updating clients fetch it.
const plugin = read('plugin/.claude-plugin/plugin.json');
if (pluginLaunchChanged) {
  const [major, minor, patch] = String(plugin.version).split('.').map(Number);
  plugin.version = `${major}.${minor}.${patch + 1}`;
  write('plugin/.claude-plugin/plugin.json', plugin);
  changed.push('plugin/.claude-plugin/plugin.json');
}

// 4. The marketplace entry is what /plugin resolves updates from.
const marketplace = read('.claude-plugin/marketplace.json');
const entry = marketplace.plugins?.find((p) => p.name === 'squire');
if (!entry) {
  throw new Error('.claude-plugin/marketplace.json has no squire plugin entry');
}
if (entry.version !== plugin.version) {
  entry.version = plugin.version;
  write('.claude-plugin/marketplace.json', marketplace);
  changed.push('.claude-plugin/marketplace.json');
}

// 5. Published text: every explicit pin moves with the release, so the
//    post-publish pin commit also fixes README, docs and skill examples.
const explicitPin = /@sniffski\/squire@\d+\.\d+\.\d+/g;
for (const file of publishedFiles()) {
  let text;
  try {
    text = readFileSync(at(file), 'utf8');
  } catch {
    continue;
  }
  const next = text.replace(explicitPin, spec);
  if (next !== text) {
    writeFileSync(at(file), next);
    changed.push(file);
  }
}

if (changed.length === 0) {
  console.log(`✓ Pins already at ${version}; nothing to sync`);
} else {
  console.log(`✓ Synced ${version}: ${changed.join(', ')}`);
}

/** Every file verify-pins.mjs scans for pinned launch commands. */
function publishedFiles() {
  return [
    'README.md',
    ...walk('docs'),
    ...walk('plugin'),
    ...walk('examples'),
    ...walk('scripts'),
  ];
}

function walk(relative) {
  let stat;
  try {
    stat = statSync(at(relative));
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [relative];
  }
  const files = [];
  for (const entryName of readdirSync(at(relative))) {
    if (entryName === 'node_modules' || entryName.startsWith('.')) {
      continue;
    }
    files.push(...walk(join(relative, entryName)));
  }
  return files;
}
