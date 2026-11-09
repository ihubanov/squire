/**
 * Tools for keyboard interactions in Playwright sessions
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { elementUUIDScheme } from '../../schema.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';
import { cueAt } from '../../watch.js';

export function type(server: FastMCP): void {
  const typeSchema = z.object({
    elementUUID: elementUUIDScheme
      .optional()
      .describe(
        'Optional UUID of the element to type into. If not provided, types into the currently focused element.'
      ),
    text: z.string().describe('The text to type character by character'),
    delay: z
      .number()
      .min(0)
      .max(1000)
      .optional()
      .describe(
        'Delay between keystrokes in milliseconds. Default is 0 (instant).'
      ),
  });

  server.addTool({
    name: 'playwright_type',
    description:
      'Type text into a real input field, exactly the way a human types — character by character with optional inter-key delay. Use this for search boxes, sign-in forms, contenteditable elements, or anywhere `set_value` would skip JS-driven autocomplete/validation. Targets either a specific element (by UUID from appium_find_element) or whatever the active tab currently has focused.',
    parameters: typeSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof typeSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      assertNotProtected(driver.page.url(), 'type into');
      await assertNotUserFocused(driver.page, 'type into');

      try {
        if (args.elementUUID) {
          const el = driver.requireElement(args.elementUUID);
          await cueAt(driver.page, el, 'input');
          await el.type(args.text, { delay: args.delay });
        } else {
          await driver.page.keyboard.type(args.text, { delay: args.delay });
        }
        logActivity({
          tool: 'playwright_type',
          tab: driver.page.url(),
          status: 'ok',
          detail: args.text.slice(0, 60),
        });

        return {
          content: [
            {
              type: 'text',
              text: `Successfully typed "${args.text}"${args.elementUUID ? ` into element ${args.elementUUID}` : ''}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to type text. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function pressKey(server: FastMCP): void {
  const pressKeySchema = z.object({
    key: z
      .string()
      .describe(
        'Key to press. Examples: "Enter", "Tab", "Escape", "ArrowDown", "Control+a", "Meta+c", "Shift+Tab"'
      ),
  });

  server.addTool({
    name: 'playwright_press_key',
    description:
      "Press a keyboard key or key combination on the AI's active tab — same as a human pressing it. Use Enter to submit a form after typing in a search box, Tab to advance focus, ArrowDown to scroll suggestions, etc. Supports modifiers (Control, Shift, Alt, Meta).",
    parameters: pressKeySchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof pressKeySchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      assertNotProtected(driver.page.url(), 'press key on');
      await assertNotUserFocused(driver.page, 'press key on');

      try {
        await driver.page.keyboard.press(args.key);
        logActivity({
          tool: 'playwright_press_key',
          tab: driver.page.url(),
          status: 'ok',
          detail: args.key,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Successfully pressed key "${args.key}"`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to press key "${args.key}". Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
