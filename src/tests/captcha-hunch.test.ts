/**
 * Hunch judge path for reCAPTCHA grids. No network: fetch is stubbed, so the
 * test pins the request shape, the p_yes gate and the tile-index mapping.
 */
import { describe, test, expect, afterEach, jest } from '@jest/globals';
import {
  hunchGridConfig,
  pickTilesHunch,
} from '../tools/web/captcha-vision.js';

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.APPIUM_MCP_CAPTCHA_HUNCH;
  delete process.env.APPIUM_MCP_CAPTCHA_HUNCH_URL;
  delete process.env.APPIUM_MCP_CAPTCHA_HUNCH_MODEL;
});

describe('hunchGridConfig', () => {
  test('is off unless APPIUM_MCP_CAPTCHA_HUNCH=1', () => {
    expect(hunchGridConfig()).toBeNull();
    process.env.APPIUM_MCP_CAPTCHA_HUNCH = 'true';
    expect(hunchGridConfig()).toBeNull();
    process.env.APPIUM_MCP_CAPTCHA_HUNCH = '1';
    expect(hunchGridConfig()).toEqual({
      url: 'http://127.0.0.1:8791',
      model: 'main',
      gate: 0.9,
    });
  });

  test('takes a URL without a trailing slash and a model override', () => {
    process.env.APPIUM_MCP_CAPTCHA_HUNCH = '1';
    process.env.APPIUM_MCP_CAPTCHA_HUNCH_URL = 'http://judge.test:9000/';
    process.env.APPIUM_MCP_CAPTCHA_HUNCH_MODEL = 'gemma';
    expect(hunchGridConfig()).toEqual({
      url: 'http://judge.test:9000',
      model: 'gemma',
      gate: 0.9,
    });
  });
});

const config = { url: 'http://judge.test', model: 'main', gate: 0.9 };

/** p_yes per tile index, read back out of the image payload. */
function scoreByImage(body: any): number {
  const image = body.images[0] as string;
  const index = Number(/tile-(\d+)/.exec(image)?.[1]);
  return index === 2 || index === 5 ? 0.95 : 0.2;
}

const tiles = Array.from({ length: 9 }, (_, index) => ({
  index,
  image: `data:image/png;base64,tile-${index}`,
}));

describe('pickTilesHunch', () => {
  test('posts one image and one yesno per tile, and gates on p_yes', async () => {
    const bodies: any[] = [];
    let inflight = 0;
    let peak = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as any).body));
      bodies.push(body);
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return new Response(
        JSON.stringify({
          results: { tile: { p_yes: scoreByImage(body), answer: 'yes' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const picked = await pickTilesHunch({
      config,
      prompt: 'Select all images with a bus',
      tiles,
    });

    expect(picked).toEqual([2, 5]);
    expect(bodies).toHaveLength(9);
    for (const body of bodies) {
      expect(body.model).toBe('main');
      expect(body.images).toHaveLength(1);
      expect(Object.keys(body.checks)).toEqual(['tile']);
      expect(body.checks.tile.kind).toBe('yesno');
      expect(body.checks.tile.question).toContain(
        'Select all images with a bus'
      );
      expect(body.reasoning).toBe('off');
    }
    // One image per request: the judge re-prefills on every check, so the
    // batched form is not used.
    expect(peak).toBeLessThanOrEqual(4);
  });

  test('all scores below the gate select nothing', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: { tile: { p_yes: 0.5 } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    expect(await pickTilesHunch({ config, prompt: 'bus', tiles })).toEqual([]);
  });

  test('an unreachable judge is "no answer", not "nothing selected"', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('down', { status: 503 }));
    expect(await pickTilesHunch({ config, prompt: 'bus', tiles })).toBeNull();
  });

  test('partial failures keep a positive but refuse to guess "nothing"', async () => {
    let n = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Fail the first four; the rest score below the gate.
      return ++n <= 4
        ? new Response('down', { status: 503 })
        : new Response(JSON.stringify({ results: { tile: { p_yes: 0.1 } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
    });
    expect(await pickTilesHunch({ config, prompt: 'bus', tiles })).toBeNull();
  });
});
