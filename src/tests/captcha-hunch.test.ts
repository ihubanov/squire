/**
 * Hunch judge path for reCAPTCHA grids. No network and no hunch install: the
 * "judge" is a tiny shell script that reads the JSON request and prints a
 * JSON reply, exactly like `hunch judge -` does.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from '@jest/globals';
import {
  hunchGridConfig,
  pickTilesHunch,
  type HunchGridConfig,
} from '../tools/web/captcha-vision.js';

let dir: string;

/** A fake `hunch` CLI: reads stdin, prints one JSON object. */
function fakeJudge(name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nbody=$(cat)\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

let okJudge: string;
let belowGateJudge: string;
let failingJudge: string;
let partialJudge: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'squire-hunch-'));
  okJudge = fakeJudge(
    'ok',
    String.raw`idx=$(printf '%s' "$body" | sed -n 's/.*tile-\([0-9][0-9]*\).*/\1/p')
case "$idx" in
  2|5) p=0.95 ;;
  *)   p=0.2 ;;
esac
[ -n "$SQUIRE_TEST_BODY_LOG" ] && printf '%s' "$body" > "$SQUIRE_TEST_BODY_LOG"
printf '{"results":{"tile":{"p_yes":%s}}}\n' "$p"`
  );
  belowGateJudge = fakeJudge(
    'below',
    `printf '{"results":{"tile":{"p_yes":0.5}}}\\n'`
  );
  failingJudge = fakeJudge('fail', 'exit 1');
  partialJudge = fakeJudge(
    'partial',
    String.raw`idx=$(printf '%s' "$body" | sed -n 's/.*tile-\([0-9][0-9]*\).*/\1/p')
case "$idx" in
  0|1|2|3) exit 1 ;;
  *)       printf '{"results":{"tile":{"p_yes":0.1}}}\n' ;;
esac`
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.APPIUM_MCP_CAPTCHA_HUNCH;
  delete process.env.APPIUM_MCP_CAPTCHA_HUNCH_CMD;
  delete process.env.APPIUM_MCP_CAPTCHA_HUNCH_MODEL;
  delete process.env.SQUIRE_TEST_BODY_LOG;
});

describe('hunchGridConfig', () => {
  test('is off unless APPIUM_MCP_CAPTCHA_HUNCH=1', () => {
    expect(hunchGridConfig()).toBeNull();
    process.env.APPIUM_MCP_CAPTCHA_HUNCH = 'true';
    expect(hunchGridConfig()).toBeNull();
    process.env.APPIUM_MCP_CAPTCHA_HUNCH = '1';
    const config = hunchGridConfig();
    expect(config?.gate).toBe(0.9);
    expect(Array.isArray(config?.command)).toBe(true);
    expect(config?.command.length).toBeGreaterThan(0);
    // Unset model: hunch applies its own configured default_model ("main").
    expect(config?.model).toBeUndefined();
  });

  test('a bare command path and a model override', () => {
    process.env.APPIUM_MCP_CAPTCHA_HUNCH = '1';
    process.env.APPIUM_MCP_CAPTCHA_HUNCH_CMD = '/opt/hunch/bin/hunch';
    process.env.APPIUM_MCP_CAPTCHA_HUNCH_MODEL = 'gemma';
    expect(hunchGridConfig()).toEqual({
      command: ['/opt/hunch/bin/hunch'],
      model: 'gemma',
      gate: 0.9,
    });
  });

  test('a JSON argv prefix survives, e.g. python3 /opt/hunch.pyz', () => {
    process.env.APPIUM_MCP_CAPTCHA_HUNCH = '1';
    process.env.APPIUM_MCP_CAPTCHA_HUNCH_CMD = '["python3","/opt/hunch.pyz"]';
    expect(hunchGridConfig()?.command).toEqual(['python3', '/opt/hunch.pyz']);
  });
});

const config = (command: string, model?: string): HunchGridConfig => ({
  command: [command],
  model,
  gate: 0.9,
});

const tiles = Array.from({ length: 9 }, (_, index) => ({
  index,
  image: `data:image/png;base64,tile-${index}`,
}));

describe('pickTilesHunch', () => {
  test('runs one hunch child per tile and gates on p_yes', async () => {
    const bodyLog = join(dir, 'body.json');
    process.env.SQUIRE_TEST_BODY_LOG = bodyLog;
    const picked = await pickTilesHunch({
      config: config(okJudge, 'main'),
      prompt: 'Select all images with a bus',
      tiles,
    });

    expect(picked).toEqual([2, 5]);
    // The fake judge keeps the last request body; check the shape Squire
    // sends to `hunch judge -` (no server, no URL).
    const body = JSON.parse(readFileSync(bodyLog, 'utf8'));
    expect(body.model).toBe('main');
    expect(body.images).toHaveLength(1);
    expect(Object.keys(body.checks)).toEqual(['tile']);
    expect(body.checks.tile.kind).toBe('yesno');
    expect(body.checks.tile.question).toContain('Select all images with a bus');
    expect(body.effort).toBe('low');
  });

  test('the model is omitted when not configured', async () => {
    const bodyLog = join(dir, 'body-default.json');
    process.env.SQUIRE_TEST_BODY_LOG = bodyLog;
    await pickTilesHunch({
      config: config(okJudge),
      prompt: 'bus',
      tiles: [tiles[2]],
      concurrency: 1,
    });
    const body = JSON.parse(readFileSync(bodyLog, 'utf8'));
    expect('model' in body).toBe(false);
  });

  test('all scores below the gate select nothing', async () => {
    expect(
      await pickTilesHunch({
        config: config(belowGateJudge),
        prompt: 'bus',
        tiles,
      })
    ).toEqual([]);
  });

  test('an unusable judge is "no answer", not "nothing selected"', async () => {
    expect(
      await pickTilesHunch({
        config: config(failingJudge),
        prompt: 'bus',
        tiles,
      })
    ).toBeNull();
  });

  test('partial failures keep a positive but refuse to guess "nothing"', async () => {
    expect(
      await pickTilesHunch({
        config: config(partialJudge),
        prompt: 'bus',
        tiles,
      })
    ).toBeNull();
  });

  test('a missing hunch binary is "no answer"', async () => {
    expect(
      await pickTilesHunch({
        config: config('/nonexistent/hunch'),
        prompt: 'bus',
        tiles,
      })
    ).toBeNull();
  });
});
