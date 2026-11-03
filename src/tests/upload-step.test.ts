/**
 * Real-Chromium tests for run_script's upload step: files go into a hidden
 * <input type=file> directly, into the input a button opens through the file
 * picker, and relative or missing paths are refused.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await jest.unstable_mockModule('../activity-log', () => ({
  logActivity: jest.fn(async () => {}),
}));

const { chromium } = await import('playwright');
const { runScript } = await import('../human-driver.js');

const PAGE = `<!doctype html><html><body>
  <input id="stale" type="file" style="display:none">
  <div role="dialog"><input id="pic" type="file" style="display:none"></div>
  <button id="pick" onclick="const i=document.createElement('input');i.type='file';
    i.onchange=()=>{window.__picked=i.files[0].name};i.click()">Upload</button>
</body></html>`;

let browser: import('playwright').Browser;
let file: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squire-upload-'));
  file = join(dir, 'thumb.png');
  writeFileSync(file, 'not really a png');
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe('upload step', () => {
  test('sets files on a hidden file input', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      const res = await runScript(page, [
        {
          action: 'upload',
          selector: '[role=dialog] input[type=file]',
          files: [file],
        },
      ]);
      expect(res.finished).toBe(true);
      expect(
        await page.$eval(
          '#pic',
          (el) => (el as HTMLInputElement).files?.[0]?.name
        )
      ).toBe('thumb.png');
      expect(
        await page.$eval(
          '#stale',
          (el) => (el as HTMLInputElement).files?.length
        )
      ).toBe(0);
    } finally {
      await page.close();
    }
  });

  test('takes the file picker a button opens', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      const res = await runScript(page, [
        { action: 'upload', selector: '#pick', files: [file] },
      ]);
      expect(res.finished).toBe(true);
      expect(res.results[0]?.detail).toMatch(/file picker/);
      await page.waitForFunction(() => (window as any).__picked);
      expect(await page.evaluate(() => (window as any).__picked)).toBe(
        'thumb.png'
      );
    } finally {
      await page.close();
    }
  });

  test('says when more than one element matched', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      const res = await runScript(page, [
        { action: 'upload', selector: 'input[type=file]', files: [file] },
      ]);
      expect(res.results[0]?.detail).toMatch(/2 elements matched/);
    } finally {
      await page.close();
    }
  });

  test('refuses relative and missing paths', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      const rel = await runScript(page, [
        { action: 'upload', selector: '#pic', files: ['thumb.png'] },
      ]);
      expect(rel.results[0]?.error).toMatch(/not an absolute path/);
      const missing = await runScript(page, [
        { action: 'upload', selector: '#pic', files: ['/nope/x.png'] },
      ]);
      expect(missing.results[0]?.error).toMatch(/does not exist/);
    } finally {
      await page.close();
    }
  });
});
