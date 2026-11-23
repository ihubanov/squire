#!/usr/bin/env node
/**
 * Fail if any released artifact disagrees with package.json's version.
 *
 * A release that forgets one of these ships the wrong server to every user:
 *   - the plugin's pin must be exactly `@sniffski/squire@<package version>`
 *     and must go through plugin/bin/squire-mcp.mjs (the cache-repairing
 *     launcher), otherwise plugin users keep running an old server or a
 *     corrupt npx cache kills the launch;
 *   - plugin.json and the marketplace entry must carry the same version,
 *     because Claude Code resolves plugin updates from the marketplace entry;
 *   - the plugin must expose exactly one MCP server named squire, installed
 *     from ./plugin, so a user ends up with one server rather than a
 *     plugin-plus-hand-written duplicate;
 *   - the legacy `scripts/install-backend.sh` stays retired: a bare run exits
 *     0 without installing a backend, `--legacy-backend` is required to
 *     install, and no workflow or npm script may invoke it;
 *   - server.json (the MCP registry manifest) must match;
 *   - no published-facing text may point at a different version or an
 *     unpinned server.
 *
 * Used by CI (ci.yml) and the Release workflow, and mirrored by
 * src/tests/release-pins.test.ts for local `npm test`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const read = (relative) => readFileSync(join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

let pkg;
let plugin;
let marketplace;
let serverJson;
let mcp;
try {
  pkg = json('package.json');
  plugin = json('plugin/.claude-plugin/plugin.json');
  marketplace = json('.claude-plugin/marketplace.json');
  serverJson = json('server.json');
  mcp = json('plugin/.mcp.json');
} catch (error) {
  console.error(`verify-pins: cannot read a manifest: ${error.message}`);
  process.exit(1);
}

const version = pkg.version;
const spec = `@sniffski/squire@${version}`;

// Plugin launch: shim + exact pin.
const server = mcp.mcpServers?.squire;
if (!server) {
  errors.push('plugin/.mcp.json: no mcpServers.squire entry');
} else {
  const args = Array.isArray(server.args) ? server.args : [];
  const pins = args.filter(
    (arg) => typeof arg === 'string' && arg.startsWith('@sniffski/squire@')
  );
  if (pins.length !== 1) {
    errors.push(
      `plugin/.mcp.json: expected exactly one @sniffski/squire pin, found ${
        pins.length ? pins.join(', ') : 'none'
      }`
    );
  } else if (pins[0] !== spec) {
    errors.push(
      `plugin/.mcp.json: pins ${pins[0]} but package.json is ${version}`
    );
  }
  const launcher = args[0];
  if (
    server.command !== 'node' ||
    typeof launcher !== 'string' ||
    !launcher.endsWith('/bin/squire-mcp.mjs')
  ) {
    errors.push(
      'plugin/.mcp.json: must launch via `node ${CLAUDE_PLUGIN_ROOT}/bin/squire-mcp.mjs` ' +
        'so a corrupt npx cache is repaired before npx runs'
    );
  }
}

// Exactly one server: installers must get one Squire MCP, not the plugin plus
// a hand-written duplicate.
const serverNames = Object.keys(mcp.mcpServers ?? {});
if (serverNames.length !== 1 || serverNames[0] !== 'squire') {
  errors.push(
    `plugin/.mcp.json: expected exactly one MCP server named squire, found ${
      serverNames.length ? serverNames.join(', ') : 'none'
    }`
  );
}
if (plugin.name !== 'squire') {
  errors.push(
    `plugin/.claude-plugin/plugin.json: name ${
      plugin.name ?? 'missing'
    } but the marketplace installs the squire plugin`
  );
}

// Plugin versions agree (marketplace is authoritative for updates).
const entry = marketplace.plugins?.find((p) => p.name === 'squire');
if (!entry) {
  errors.push('.claude-plugin/marketplace.json: no squire plugin entry');
} else {
  if (entry.version !== plugin.version) {
    errors.push(
      `.claude-plugin/marketplace.json: version ${entry.version} but ` +
        `plugin/.claude-plugin/plugin.json is ${plugin.version}`
    );
  }
  if (entry.source !== './plugin') {
    errors.push(
      `.claude-plugin/marketplace.json: squire source is ${
        entry.source ?? 'missing'
      } but must be ./plugin`
    );
  }
}
if (marketplace.autoUpdate !== true) {
  errors.push('.claude-plugin/marketplace.json: autoUpdate must stay true');
}

// MCP registry manifest.
if (serverJson.version !== version) {
  errors.push(
    `server.json: version ${serverJson.version} but package.json is ${version}`
  );
}
const registryPkg = serverJson.packages?.[0];
if (!registryPkg || registryPkg.version !== version) {
  errors.push(
    `server.json: package version ${registryPkg?.version ?? 'missing'} but ` +
      `package.json is ${version}`
  );
}
if (registryPkg?.identifier !== pkg.name) {
  errors.push(
    `server.json: identifier ${registryPkg?.identifier ?? 'missing'} but ` +
      `package name is ${pkg.name}`
  );
}

// Published text: no other pin, no unpinned launch.
const pinPattern = /@sniffski\/squire@(\d+\.\d+\.\d+)/g;
for (const file of publishedFiles()) {
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    continue;
  }
  for (const match of text.matchAll(pinPattern)) {
    if (match[1] !== version) {
      errors.push(`${file}: pins ${match[0]} but package.json is ${version}`);
    }
  }
  if (/npx\s+(?:-y\s+)?@sniffski\/squire(?!@)/.test(text)) {
    errors.push(`${file}: launches @sniffski/squire without an exact @version`);
  }
}

// The legacy shared backend is retired: the plugin's pinned stdio server is
// the only install path. Nothing in CI or the npm lifecycle may re-enliven it,
// and the script must keep both its retirement gate and its --uninstall path.
let backendText = '';
try {
  backendText = readFileSync(
    join(root, 'scripts', 'install-backend.sh'),
    'utf8'
  );
} catch {
  errors.push(
    'scripts/install-backend.sh: missing (retirement notice must ship)'
  );
}
if (backendText) {
  if (!backendText.includes('RETIRED (plugin provides the server)')) {
    errors.push(
      'scripts/install-backend.sh: lost the retirement gate; a bare run ' +
        'must exit 0 without installing a backend'
    );
  }
  if (!/--legacy-backend\)/.test(backendText)) {
    errors.push(
      'scripts/install-backend.sh: installing must require --legacy-backend'
    );
  }
  if (!/--uninstall\)/.test(backendText)) {
    errors.push('scripts/install-backend.sh: --uninstall branch is missing');
  }
}

const reEnablers = [];
if (JSON.stringify(pkg.scripts ?? {}).includes('install-backend')) {
  reEnablers.push('package.json scripts');
}
let workflows = [];
try {
  workflows = readdirSync(join(root, '.github', 'workflows')).filter((file) =>
    /\.ya?ml$/.test(file)
  );
} catch {
  // A partial checkout without workflows is not a release-artifact problem.
}
for (const file of workflows) {
  let text;
  try {
    text = readFileSync(join(root, '.github', 'workflows', file), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('install-backend')) {
    reEnablers.push(`.github/workflows/${file}`);
  }
}
if (reEnablers.length > 0) {
  errors.push(
    'the legacy backend installer is retired but invoked by ' +
      `${reEnablers.join(', ')}; the plugin is the only install path`
  );
}

if (errors.length > 0) {
  console.error(`verify-pins: ${errors.length} problem(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}
console.log(`✓ All release pins match ${version}`);

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
    stat = statSync(join(root, relative));
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [relative];
  }
  const files = [];
  for (const entryName of readdirSync(join(root, relative))) {
    if (entryName === 'node_modules' || entryName.startsWith('.')) {
      continue;
    }
    files.push(...walk(join(relative, entryName)));
  }
  return files;
}
