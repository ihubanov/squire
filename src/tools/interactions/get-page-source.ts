import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import {
  createUIResource,
  createPageSourceInspectorUI,
  addUIResourceToResponse,
} from '../../ui/mcp-ui-utils.js';
import { getPageSource as _getPageSource } from '../../command.js';

export default function getPageSource(server: FastMCP): void {
  const pageSourceSchema = z.object({});
  server.addTool({
    name: 'appium_get_page_source',
    description:
      'Get the page source of the current screen (XML for native apps, HTML for web/Playwright sessions). ' +
      'The full source is saved to a file and a capped preview is returned inline; read the file for the complete source.',
    parameters: pageSourceSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    execute: async (
      _args: z.infer<typeof pageSourceSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver) {
        throw new Error('No driver found. Please create a session first.');
      }

      try {
        const pageSource = await _getPageSource(driver);
        if (!pageSource) {
          throw new Error('Page source is empty or null');
        }

        // Web sessions return HTML; native sessions return XML. Label the
        // fence accordingly (the old code always said "xml", misleading the
        // model on web pages).
        const isWeb = isPlaywrightDriverSession(driver);
        const lang = isWeb ? 'html' : 'xml';

        // Persist the full source so the capped preview never loses data.
        const dir = os.tmpdir();
        await mkdir(dir, { recursive: true });
        const filepath = join(dir, `page_source_${Date.now()}.${lang}`);
        await writeFile(filepath, pageSource, 'utf8');

        const max = previewLimit();
        const truncated = pageSource.length > max;
        const preview = truncated ? pageSource.slice(0, max) : pageSource;
        const note = truncated
          ? `\n[Preview truncated: showing ${max} of ${pageSource.length} characters. ` +
            `Read ${filepath} for the full source, or raise APPIUM_MCP_PAGE_SOURCE_MAX.]`
          : '';

        const textResponse: ContentResult = {
          content: [
            {
              type: 'text',
              text:
                `Page source (${lang.toUpperCase()}, ${pageSource.length} chars) saved to: ${filepath}\n` +
                '```' +
                lang +
                '\n' +
                preview +
                '\n```' +
                note,
            },
          ],
        };

        // The interactive inspector embeds the full source again and is only
        // useful on mcp-ui hosts; keep it opt-in so it can't blow the token
        // budget on plain hosts.
        if (process.env.APPIUM_MCP_UI !== '1') {
          return textResponse;
        }

        const uiResource = createUIResource(
          `ui://appium-mcp/page-source-inspector/${Date.now()}`,
          createPageSourceInspectorUI(pageSource)
        );

        return addUIResourceToResponse(textResponse, uiResource);
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get page source. Error: ${err.toString()}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}

// Preview size cap (characters). Page source for a real web app can be 100k+
// characters, which blows the host's per-tool output token limit and gets
// truncated-and-dumped-to-file by the client anyway. We instead save the FULL
// source to a file ourselves and inline only a capped preview, so nothing is
// lost (the model can Read the file for the rest) and the response stays small.
// Override with APPIUM_MCP_PAGE_SOURCE_MAX.
function previewLimit(): number {
  const raw = Number(process.env.APPIUM_MCP_PAGE_SOURCE_MAX);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}
