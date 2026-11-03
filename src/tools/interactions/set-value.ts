import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { elementUUIDScheme } from '../../schema.js';
import { setValue as _setValue } from '../../command.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

export default function setValue(server: FastMCP): void {
  const setValueSchema = z.object({
    elementUUID: elementUUIDScheme,
    text: z.string().describe('The text to enter'),
  });

  server.addTool({
    name: 'appium_set_value',
    description: 'Enter text into an element',
    parameters: setValueSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof setValueSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver) {
        throw new Error('No driver found');
      }

      // For Playwright web sessions, enforce the same per-tab protections
      // we apply to click/navigate/evaluate. On a CDP-attached browser this
      // stops the AI from typing into the protected TUI tab or the tab the
      // user is actively working in. Mobile (Appium) sessions have no "tab"
      // concept and skip the guard.
      if (isPlaywrightDriverSession(driver)) {
        assertNotProtected(driver.page.url(), 'set value on');
        await assertNotUserFocused(driver.page, 'set value on');
      }

      try {
        await _setValue(driver, args.elementUUID, args.text);
        if (isPlaywrightDriverSession(driver)) {
          logActivity({
            tool: 'appium_set_value',
            tab: driver.page.url(),
            status: 'ok',
          });
        }
        return {
          content: [
            {
              type: 'text',
              text: `Successfully set value ${args.text} into element ${args.elementUUID}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to set value ${args.text} into element ${args.elementUUID}. err: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
