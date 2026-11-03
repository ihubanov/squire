/**
 * Vision grounding client — gives the web tools "eyes" for DOM-blind content.
 *
 * Canvas, WebGL, embedded viewers and images have no locatable DOM nodes, so
 * the human-fallback ladder in human-driver.ts ends in failure there. This
 * module is the final rung: it screenshots the page and asks the Python
 * sidecar (scripts/vision-grounding.py) to ground a *visible label* via OCR
 * (tesseract) — or, when configured, an ONNX detector (e.g. OmniParser's
 * MIT-licensed YOLOv9-E) — and returns viewport coordinates you can click.
 *
 * Deliberately lazy and optional: the sidecar process is only spawned on the
 * first vision request, so pages that never need eyes never pay for them.
 * Disable the whole rung with APPIUM_MCP_VISION=0. Point
 * APPIUM_MCP_VISION_MODEL at an .onnx detector to upgrade from OCR-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Page } from 'playwright';

/** A grounded region in VIEWPORT coordinates. */
export interface GroundedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  backend: string;
}

// ── sidecar lifecycle ──────────────────────────────────────────────────────

let sidecar: ChildProcess | null = null;
let sidecarDead = false;

interface SidecarResponse {
  ok: boolean;
  reason?: string;
  match?: {
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
    backend: string;
  };
  backends?: string[];
}

/**
 * Report which grounding backends are available, without making a request.
 * Used to explain (in errors) why a visual fallback did not fire.
 */
export async function visionBackends(): Promise<string[]> {
  if (!visionEnabled()) {
    return [];
  }
  try {
    const resp = await sidecarRequest({ op: 'ping' }, 5000);
    return resp.ok ? (resp.backends ?? []) : [];
  } catch {
    return [];
  }
}

/**
 * Ground a visible text label on the page and return its viewport rectangle.
 * Takes a full-page-mousedown screenshot, asks the sidecar to OCR-locate
 * `target`, and rescales from screenshot pixels to viewport coordinates
 * (devicePixelRatio on CDP-attached browsers is often not 1).
 *
 * Returns null when the label is not on screen or vision is unavailable —
 * callers treat that as "rung failed", never as a crash.
 */
export async function groundLabelOnPage(
  page: Page,
  target: string,
  timeoutMs = 10_000
): Promise<GroundedRegion | null> {
  if (!visionEnabled() || !target.trim()) {
    return null;
  }

  const viewport = page.viewportSize();
  let screenshot: Buffer;
  try {
    screenshot = await page.screenshot({ type: 'png' });
  } catch (err) {
    console.error(`[vision-grounding] screenshot failed: ${errMsg(err)}`);
    return null; // page closed mid-flight, CDP hiccup — not our problem to solve
  }

  // PNG header: bytes 16..24 are width/height big-endian.
  const imgW = screenshot.readUInt32BE(16);
  const imgH = screenshot.readUInt32BE(20);
  const scaleX = viewport ? imgW / viewport.width : 1;
  const scaleY = viewport ? imgH / viewport.height : 1;

  try {
    const resp = await sidecarRequest(
      {
        op: 'ground',
        screenshot: screenshot.toString('base64'),
        target,
        width: imgW,
        height: imgH,
      },
      timeoutMs
    );
    if (!resp.ok || !resp.match) {
      console.error(
        `[vision-grounding] no match for ${JSON.stringify(target)}: ${resp.reason ?? 'no match in response'}`
      );
      return null;
    }
    const m = resp.match;
    return {
      // Match region (top-left, screenshot px) → viewport px, centered.
      x: Math.round(m.x / scaleX),
      y: Math.round(m.y / scaleY),
      w: Math.round(m.w / scaleX),
      h: Math.round(m.h / scaleY),
      text: m.text,
      backend: m.backend,
    };
  } catch (err) {
    console.error(`[vision-grounding] sidecar request failed: ${errMsg(err)}`);
    return null;
  }
}

function visionEnabled(): boolean {
  const v = process.env.APPIUM_MCP_VISION;
  return !(v != null && ['0', 'false', 'no'].includes(v.trim().toLowerCase()));
}

function sidecarScript(): string {
  const explicit = process.env.APPIUM_MCP_VISION_SIDECAR;
  if (explicit) {
    return explicit;
  }
  // Works for both src/ (tests, dev) and dist/ (built) since each is one
  // level below the repo root, where scripts/ lives.
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'vision-grounding.py'
  );
}

function sidecarPython(): string {
  // onnxruntime has no wheels for every Python (3.14 notably), so when an
  // ONNX detector is configured the sidecar usually needs to run inside a
  // venv — point APPIUM_MCP_VISION_PYTHON at that interpreter.
  return process.env.APPIUM_MCP_VISION_PYTHON ?? 'python3';
}

// ── page-level API ─────────────────────────────────────────────────────────

function ensureSidecar(): ChildProcess {
  if (sidecar && !sidecarDead) {
    return sidecar;
  }
  const proc = spawn(sidecarPython(), [sidecarScript()], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.on('error', (err) => {
    // ENOENT on the interpreter, etc. — without this the pending request
    // would only fail via the timeout, hiding the real cause.
    sidecarDead = true;
    console.error(
      `[vision-grounding] failed to spawn ${sidecarPython()}: ${err.message}`
    );
  });
  sidecarDead = false;
  proc.on('exit', () => {
    sidecarDead = true;
    sidecar = null;
  });
  proc.stderr?.on('data', (d: Buffer) => {
    // Surface sidecar stderr but never crash the server for it.

    console.error(`[vision-grounding] ${d.toString().trimEnd()}`);
  });
  // A spawned child is an ACTIVE handle: without unref, a one-shot process
  // (script, test) that grounds once would hang forever waiting for the
  // sidecar to exit — while the sidecar waits for stdin lines. Deadlock.
  // Unref lets the parent exit independently; the exit handler below then
  // kills the sidecar (and the sidecar also self-exits after idle as a
  // belt-and-suspenders backstop).
  proc.unref();
  // stdio streams are sockets at runtime; their static type just doesn't
  // declare unref.
  (proc.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  (proc.stdout as unknown as { unref?: () => void } | null)?.unref?.();
  (proc.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  // Never leave a spawned python behind when the host process exits.
  process.on('exit', () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  });
  sidecar = proc;
  return proc;
}

/**
 * One JSON-lines request/response round-trip with the sidecar. A request id
 * prefix lets us ignore lines that aren't ours (there are none today, but the
 * guard is cheap).
 */
function sidecarRequest(
  request: Record<string, unknown>,
  timeoutMs: number
): Promise<SidecarResponse> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = ensureSidecar();
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`vision sidecar timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let buf = '';
    const onStdout = (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        return;
      }
      const line = buf.slice(0, nl).trim();
      cleanup();
      if (!line) {
        reject(new Error('vision sidecar returned an empty line'));
        return;
      }
      try {
        resolve(JSON.parse(line) as SidecarResponse);
      } catch {
        reject(
          new Error(`vision sidecar returned non-JSON: ${line.slice(0, 200)}`)
        );
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(`vision sidecar exited (code ${code}) before answering`)
      );
    };

    function cleanup(): void {
      clearTimeout(timer);
      proc.stdout?.off('data', onStdout);
      proc.off('exit', onExit);
    }

    proc.stdout?.on('data', onStdout);
    proc.once('exit', onExit);
    proc.stdin?.write(JSON.stringify(request) + '\n');
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
