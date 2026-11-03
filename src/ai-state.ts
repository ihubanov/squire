/**
 * Tiny shared-state file written by appium-mcp so that other processes
 * (in particular ai-colleague's tab-watcher-mcp) can answer "which tab is
 * the AI currently working on?" without IPC.
 *
 * Path is configurable via AI_COLLEAGUE_AI_STATE_FILE; defaults to
 * /tmp/ai-colleague-ai-state.json. Writes are best-effort and silent —
 * the file is purely advisory.
 */
import { writeFileSync } from 'node:fs';

const STATE_PATH =
  process.env.AI_COLLEAGUE_AI_STATE_FILE ?? '/tmp/ai-colleague-ai-state.json';

export function writeAiActiveTab(index: number, url: string): void {
  try {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({
        aiActiveTabIndex: index,
        aiActiveTabUrl: url,
        updatedAt: new Date().toISOString(),
      }),
      'utf8'
    );
  } catch {
    // Silent — this is advisory state.
  }
}
