/**
 * Tests for the DataDome frame classifier ported from
 * tools/security/captcha/ddetect.py.
 *
 * fixtures/datadome-hard-block.html is a real capture (auth.olx.bg login
 * redirect, 21 KB Bulgarian "Блокирани сте" frame) kept so the exact marker
 * is tested against a document DataDome actually served.
 */
import { readFileSync } from 'node:fs';
import { describe, test, expect } from '@jest/globals';
import {
  DATADOME_FRAME_HOST,
  classifyDatadomeFrame,
  detectDatadome,
  findHardBlock,
} from '../datadome-detect.js';

const HARD_BLOCK_HTML =
  '<html><body data-dd-response-page="hard-block">Access denied</body></html>';

function pageOf(
  frames: Array<{ url: string; html?: string; throws?: boolean }>
) {
  return {
    frames: () =>
      frames.map((f) => ({
        url: () => f.url,
        content: async () => {
          if (f.throws) throw new Error('frame detached');
          return f.html ?? '';
        },
      })),
  };
}

describe('classifyDatadomeFrame', () => {
  test('classifies the real captured hard-block document', () => {
    const html = readFileSync(
      new URL('./fixtures/datadome-hard-block.html', import.meta.url),
      'utf8'
    );
    const v = classifyDatadomeFrame(
      `https://${DATADOME_FRAME_HOST}/captcha/`,
      html
    );
    expect(v.kind).toBe('hard-block');
    expect(v.solvable).toBe(false);
  });

  test('hard-block body wins over an interstitial URL', () => {
    const v = classifyDatadomeFrame(
      `https://${DATADOME_FRAME_HOST}/interstitial/`,
      HARD_BLOCK_HTML
    );
    expect(v.kind).toBe('hard-block');
    expect(v.solvable).toBe(false);
    expect(v.detail).toContain('reputation block');
  });

  test('hard-block marker is case-sensitive and double-quoted', () => {
    const v = classifyDatadomeFrame(
      `https://${DATADOME_FRAME_HOST}/`,
      "<body data-dd-response-page='hard-block'>"
    );
    expect(v.kind).toBe('unknown');
  });

  test('interstitial URL without a body classifies as interstitial', () => {
    const v = classifyDatadomeFrame(
      `https://${DATADOME_FRAME_HOST}/interstitial/`,
      null
    );
    expect(v.kind).toBe('interstitial');
    expect(v.solvable).toBe(false);
  });

  test('an interactive challenge is captcha and solvable', () => {
    const v = classifyDatadomeFrame(
      `https://${DATADOME_FRAME_HOST}/captcha/`,
      '<div class="captcha__container"></div>'
    );
    expect(v.kind).toBe('captcha');
    expect(v.solvable).toBe(true);
  });

  test('unrecognised body is unknown, never solvable', () => {
    const v = classifyDatadomeFrame(
      `https://${DATADOME_FRAME_HOST}/x`,
      '<html></html>'
    );
    expect(v.kind).toBe('unknown');
    expect(v.solvable).toBe(false);
  });

  test('frame URL is capped at 300 chars', () => {
    const long = `https://${DATADOME_FRAME_HOST}/` + 'a'.repeat(400);
    const v = classifyDatadomeFrame(long, null);
    expect(v.url).toHaveLength(300);
  });
});

describe('detectDatadome', () => {
  test('ignores frames outside geo.captcha-delivery.com', async () => {
    const page = pageOf([
      { url: 'https://example.com/frame', html: HARD_BLOCK_HTML },
    ]);
    expect(await detectDatadome(page)).toEqual([]);
  });

  test('no geo frame is not a pass: detect returns an empty list', async () => {
    expect(await detectDatadome(pageOf([]))).toEqual([]);
  });

  test('detects a hard-block in the frame document, not the top page', async () => {
    const page = pageOf([
      {
        url: `https://${DATADOME_FRAME_HOST}/interstitial/`,
        html: HARD_BLOCK_HTML,
      },
      { url: 'about:blank', html: '' },
    ]);
    const verdicts = await detectDatadome(page);
    expect(verdicts).toHaveLength(1);
    expect(findHardBlock(verdicts)?.kind).toBe('hard-block');
  });

  test('a frame whose content cannot be read still yields a verdict', async () => {
    const page = pageOf([
      { url: `https://${DATADOME_FRAME_HOST}/x`, throws: true },
    ]);
    const [v] = await detectDatadome(page);
    expect(v.kind).toBe('unknown');
    expect(v.present).toBe(true);
  });
});
