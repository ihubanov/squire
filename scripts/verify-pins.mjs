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

// Plugin versions agree (marketplace is authoritative for updates).
const entry = marketplace.plugins?.find((p) => p.name === 'squire');
if (!entry) {
  errors.push('.claude-plugin/marketplace.json: no squire plugin entry');
} else if (entry.version !== plugin.version) {
  errors.push(
    `.claude-plugin/marketplace.json: version ${entry.version} but ` +
      `plugin/.claude-plugin/plugin.json is ${plugin.version}`
  );
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
