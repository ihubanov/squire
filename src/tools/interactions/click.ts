import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { elementUUIDScheme } from '../../schema.js';
import { elementClick as _elementClick } from '../../command.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

export default function generateTest(server: FastMCP): void {
  const clickActionSchema = z.object({
    elementUUID: elementUUIDScheme,
  });

  server.addTool({
    name: 'appium_click',
    description:
      'Click an element. In a Playwright web session this clicks like a human cursor — full mouse-down/up, JS click handlers fire, navigation/form submission happens normally. Use it on links, buttons, search-result entries, login submit buttons, etc. Element is identified by UUID from appium_find_element.',
    parameters: clickActionSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof clickActionSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver) {
        throw new Error('No driver found');
      }

      // For Playwright web sessions, enforce the same per-tab protections
      // we apply to navigate/evaluate/etc. Mobile (Appium) sessions don't
      // have a "tab" concept and skip the guard.
      if (isPlaywrightDriverSession(driver)) {
        assertNotProtected(driver.page.url(), 'click on');
        await assertNotUserFocused(driver.page, 'click on');
      }

      try {
        await _elementClick(driver, args.elementUUID);
        if (isPlaywrightDriverSession(driver)) {
          logActivity({
            tool: 'appium_click',
            tab: driver.page.url(),
            status: 'ok',
          });
        }
        return {
          content: [
            {
              type: 'text',
              text: `Successfully clicked on element ${args.elementUUID}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to click on element ${args.elementUUID}. err: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
