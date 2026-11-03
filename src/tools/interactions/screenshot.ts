import type { FastMCP } from 'fastmcp';
import { getDriver } from '../../session-store.js';
import { elementUUIDScheme } from '../../schema.js';
import type { NullableDriverInstance } from '../../session-store.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import * as os from 'node:os';
import {
  createUIResource,
  createScreenshotViewerUI,
  addUIResourceToResponse,
} from '../../ui/mcp-ui-utils.js';
import { getScreenshot } from '../../command.js';
import z from 'zod';
import { imageUtil } from '@appium/support';

export interface ScreenshotDeps {
  getDriver: () => NullableDriverInstance;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  resolveScreenshotDir: typeof resolveScreenshotDir;
  dateNow: () => number;
}

/**
 * Resolves the screenshot directory path.
 * - If SCREENSHOTS_DIR is not set, returns process.cwd()
 * - If SCREENSHOTS_DIR is absolute, returns it as-is
 * - If SCREENSHOTS_DIR is relative, joins it with process.cwd()
 */
export function resolveScreenshotDir(): string {
  const screenshotDir = process.env.SCREENSHOTS_DIR;

  if (!screenshotDir) {
    return os.tmpdir();
  }

  if (isAbsolute(screenshotDir)) {
    return screenshotDir;
  }

  return join(process.cwd(), screenshotDir);
}

const defaultDeps: ScreenshotDeps = {
  getDriver,
  writeFile,
  mkdir,
  resolveScreenshotDir,
  dateNow: () => Date.now(),
};

export async function executeScreenshot(opts: {
  deps?: ScreenshotDeps;
  elementId?;
  maxWidth?: number;
}): Promise<any> {
  const { deps = defaultDeps, elementId, maxWidth } = opts;

  const driver = deps.getDriver();
  if (!driver) {
    throw new Error('No driver found');
  }

  try {
    const screenshotBase64 = await getScreenshot(driver, elementId);

    // Convert base64 to buffer
    const originalBuffer = Buffer.from(screenshotBase64, 'base64');

    // Resize if maxWidth is provided and image is wider
    let screenshotBuffer: Buffer = originalBuffer;
    let displayBase64 = screenshotBase64;
    if (maxWidth !== undefined) {
      const sharp = imageUtil.requireSharp();
      const metadata = await sharp(originalBuffer).metadata();
      if (metadata.width !== undefined && metadata.width > maxWidth) {
        const resizedBuffer = await sharp(originalBuffer)
          .resize({ width: maxWidth })
          .png()
          .toBuffer();
        screenshotBuffer = Buffer.from(resizedBuffer);
        displayBase64 = screenshotBuffer.toString('base64');
      }
    }

    // Generate filename with timestamp
    const timestamp = deps.dateNow();
    const filename = `screenshot_${timestamp}.png`;
    const screenshotDir = deps.resolveScreenshotDir();

    // Create a directory if it doesn't exist
    await deps.mkdir(screenshotDir, { recursive: true });

    const filepath = join(screenshotDir, filename);

    // Save screenshot to disk
    await deps.writeFile(filepath, screenshotBuffer);

    // Return the screenshot as a real MCP image content block so the model
    // actually sees it. We send the full-resolution PNG (only pre-resized when
    // the caller explicitly passes maxWidth) and let the HOST enforce its own
    // image limits — Claude Code's MCP client resizes/compresses every image
    // block it receives (transformResultContent -> maybeResizeAndDownsampleImageBuffer),
    // so downscaling here would be redundant and just discard detail.
    //
    // The heavy base64-in-HTML "viewer" UI resource is what used to blow the
    // token budget on non-mcp-ui hosts (it lands in the resource's text field),
    // so it's now opt-in via APPIUM_MCP_UI=1. The image block + saved file path
    // cover both model consumption and human/programmatic access by default.
    const textResponse = {
      content: [
        {
          type: 'text',
          text: `Screenshot saved successfully to: ${filepath}`,
        },
        {
          type: 'image',
          data: displayBase64,
          mimeType: 'image/png',
        },
      ],
    };

    if (process.env.APPIUM_MCP_UI !== '1') {
      return textResponse;
    }

    // Opt-in: also attach the interactive mcp-ui screenshot viewer.
    const uiResource = createUIResource(
      `ui://appium-mcp/screenshot-viewer/${Date.now()}`,
      createScreenshotViewerUI(displayBase64, filepath)
    );

    return addUIResourceToResponse(textResponse, uiResource);
  } catch (err: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to take screenshot. err: ${err.toString()}`,
        },
      ],
    };
  }
}

const maxWidthSchema = z
  .number()
  .optional()
  .describe(
    'Optional maximum width in pixels to resize the screenshot. The aspect ratio is preserved. Useful for reducing token usage when sending screenshots to LLMs.'
  );

export function screenshot(server: FastMCP): void {
  const screenshotSchema = z.object({
    maxWidth: maxWidthSchema,
  });

  server.addTool({
    name: 'appium_screenshot',
    description:
      'Take a screenshot of the current screen and return as PNG image',
    parameters: screenshotSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (args: any, _context: any): Promise<any> =>
      executeScreenshot({ maxWidth: args.maxWidth }),
  });
}

export function elementScreenshot(server: FastMCP): void {
  const elementScreenshotSchema = z.object({
    elementUUID: elementUUIDScheme,
    maxWidth: maxWidthSchema,
  });

  server.addTool({
    name: 'appium_element_screenshot',
    description:
      'Take a screenshot of the given element uuid and return as PNG image',
    parameters: elementScreenshotSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (args: any, _context: any): Promise<any> =>
      executeScreenshot({
        elementId: args.elementUUID,
        maxWidth: args.maxWidth,
      }),
  });
}
