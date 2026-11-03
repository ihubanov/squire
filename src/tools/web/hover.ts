/**
 * Tool to hover over an element in Playwright sessions
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { elementUUIDScheme } from '../../schema.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

export default function hover(server: FastMCP): void {
  const hoverSchema = z.object({
    elementUUID: elementUUIDScheme,
  });

  server.addTool({
    name: 'playwright_hover',
    description:
      'Hover the mouse over an element on the active tab, just like a human cursor would. Use this to reveal hover-only menus, tooltips, or dropdown previews before clicking through.',
    parameters: hoverSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof hoverSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      assertNotProtected(driver.page.url(), 'hover on');
      await assertNotUserFocused(driver.page, 'hover on');

      try {
        const el = driver.requireElement(args.elementUUID);
        await el.hover();
        logActivity({
          tool: 'playwright_hover',
          tab: driver.page.url(),
          status: 'ok',
        });

        return {
          content: [
            {
              type: 'text',
              text: `Successfully hovered over element ${args.elementUUID}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to hover over element ${args.elementUUID}. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
