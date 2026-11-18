/**
 * Release pins. A release that forgets one of these ships the wrong server
 * to every user:
 *  - the plugin's npx pin must equal package.json, otherwise plugin users
 *    keep running the previous version;
 *  - plugin.json and the marketplace entry must carry the same version,
 *    because Claude Code resolves plugin updates from the marketplace entry;
 *  - no published-facing text may tell a user to launch an unpinned server
 *    (two registrations or a drifting `@latest` is a duplicate-server bug).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect } from '@jest/globals';

const root = new URL('../../', import.meta.url);
const read = (name: string): string =>
  readFileSync(new URL(name, root), 'utf8');
const json = (name: string): any => JSON.parse(read(name));

const pkg = json('package.json');
const plugin = json('plugin/.claude-plugin/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json');
const serverJson = json('server.json');

describe('release pins', () => {
  test('plugin .mcp.json pins the package version', () => {
    const server = json('plugin/.mcp.json').mcpServers.squire;
    const pins = (server.args as string[]).filter((arg) =>
      arg.startsWith('@sniffski/squire@')
    );
    expect(pins).toEqual([`@sniffski/squire@${pkg.version}`]);
  });

  test('the plugin launches through the cache-repairing shim', () => {
    // A bare `npx -y @sniffski/squire@<pin>` dies with ENOENT when the npx
    // cache is half-installed; the shim repairs it and retries.
    const server = json('plugin/.mcp.json').mcpServers.squire;
    expect(server.command).toBe('node');
    expect(server.args[0]).toMatch(/\/bin\/squire-mcp\.mjs$/);
    expect(read('plugin/bin/squire-mcp.mjs').length).toBeGreaterThan(0);
  });

  test('plugin.json and the marketplace entry agree', () => {
    const entry = marketplace.plugins.find(
      (p: { name: string }) => p.name === 'squire'
    );
    expect(entry).toBeTruthy();
    expect(entry.version).toBe(plugin.version);
  });

  test('the marketplace entry advertises autoUpdate', () => {
    expect(marketplace.autoUpdate).toBe(true);
  });

  test('server.json matches the package version', () => {
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0].version).toBe(pkg.version);
  });

  test('every pinned launch in published text matches the release', () => {
    // A hardcoded pin that the release forgets to bump sends copy-paste users
    // to the previous version.
    const wrong: string[] = [];
    for (const file of publishedFiles()) {
      const text = readFileSync(new URL(file, root), 'utf8');
      for (const match of text.matchAll(/@sniffski\/squire@(\d+\.\d+\.\d+)/g)) {
        if (match[1] !== pkg.version) {
          wrong.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('no published text launches an unpinned server', () => {
    const files = publishedFiles();
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(new URL(file, root), 'utf8');
      } catch {
        continue;
      }
      // `npx @sniffski/squire` with no `@version` right after it.
      if (/npx @sniffski\/squire(?!@)/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function publishedFiles(): string[] {
  return walk('README.md').concat(
    walk('docs'),
    walk('plugin'),
    walk('examples'),
    walk('scripts')
  );
}

function walk(relative: string): string[] {
  let stat;
  try {
    stat = statSync(new URL(relative, root));
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [relative];
  }
  const files: string[] = [];
  for (const entry of readdirSync(new URL(relative, root))) {
    if (entry === 'node_modules' || entry.startsWith('.')) {
      continue;
    }
    files.push(...walk(join(relative, entry)));
  }
  return files;
}
