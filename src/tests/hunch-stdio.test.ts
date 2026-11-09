/**
 * The hunch sidecar runs in library mode over stdio (`judge -`): one JSON
 * request on stdin, one JSON reply on stdout, no HTTP server and no port.
 * These tests drive it against a fake python that mimics that contract.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-hunch-test-'));
const venv = path.join(tmp, 'venv');
const bin = path.join(venv, 'bin');
const py = path.join(bin, 'python');

let runJudge: typeof import('../hunch/sidecar.js').runJudge;
let judge: typeof import('../hunch/client.js').judge;

beforeAll(async () => {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(venv, '.last-upgrade'), 'fresh');
  // Fake `python -m hunch judge -`: the mode comes from FAKE_HUNCH_MODE.
  fs.writeFileSync(
    py,
    `#!/bin/sh
cat >/dev/null
case "$FAKE_HUNCH_MODE" in
  ok)  printf '{"results":{"q":{"p_yes":0.91}},"usage":{"n":1}}\\n' ;;
  err) printf '{"error":{"code":"backend","message":"boom"}}\\n'; exit 1 ;;
  junk) printf 'not json\\n' ;;
  slow) sleep 5; printf '{}\\n' ;;
esac
`,
    { mode: 0o755 }
  );
  process.env.SQUIRE_HUNCH_VENV = venv;
  process.env.SQUIRE_HUNCH_BACKEND_URL = 'http://127.0.0.1:1';
  process.env.SQUIRE_HUNCH_BACKEND_MODEL = 'default';
  runJudge = (await import('../hunch/sidecar.js')).runJudge;
  judge = (await import('../hunch/client.js')).judge;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.SQUIRE_HUNCH_VENV;
  delete process.env.SQUIRE_HUNCH_BACKEND_URL;
  delete process.env.SQUIRE_HUNCH_BACKEND_MODEL;
});

describe('hunch over stdio', () => {
  test('returns the parsed reply from the child', async () => {
    process.env.FAKE_HUNCH_MODE = 'ok';
    const r = await runJudge({ checks: {} });
    expect(r?.results).toEqual({ q: { p_yes: 0.91 } });
    expect(r?.usage).toEqual({ n: 1 });
  });

  test('a child error object comes back, not a throw', async () => {
    process.env.FAKE_HUNCH_MODE = 'err';
    const r = await runJudge({ checks: {} });
    expect(r?.error?.message).toBe('boom');
  });

  test('unparseable output fails closed', async () => {
    process.env.FAKE_HUNCH_MODE = 'junk';
    const r = await runJudge({ checks: {} });
    expect(r?.error).toBeDefined();
  });

  test('timeout kills the child and reports an error', async () => {
    process.env.FAKE_HUNCH_MODE = 'slow';
    const t0 = Date.now();
    const r = await runJudge({ checks: {} }, 100);
    expect(r?.error?.code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('disabled without a backend url', async () => {
    const url = process.env.SQUIRE_HUNCH_BACKEND_URL;
    delete process.env.SQUIRE_HUNCH_BACKEND_URL;
    try {
      expect(await runJudge({ checks: {} })).toBeNull();
    } finally {
      process.env.SQUIRE_HUNCH_BACKEND_URL = url;
    }
  });

  test('client maps a child error to ok:false', async () => {
    process.env.FAKE_HUNCH_MODE = 'err';
    const res = await judge({
      checks: { q: { kind: 'yesno', question: 'x?' } },
    });
    expect(res).toEqual({ ok: false, reason: 'boom' });
  });

  test('client maps success to p_yes', async () => {
    process.env.FAKE_HUNCH_MODE = 'ok';
    const res = await judge({
      checks: { q: { kind: 'yesno', question: 'x?' } },
    });
    expect(res.ok && res.results.q.p_yes).toBe(0.91);
  });
});
