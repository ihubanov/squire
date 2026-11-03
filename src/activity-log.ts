/**
 * Append-only JSONL activity log shared between MCP servers and the qwen-web
 * UI. Each line is one tool-call observation. The qwen-web HTML reads the
 * tail of this file via /api/activity to show the user what the AI is doing.
 *
 * Path is configurable via AI_COLLEAGUE_ACTIVITY_LOG; defaults to
 * /tmp/ai-colleague-activity.jsonl. Writes are best-effort and silent.
 */
import { appendFileSync } from 'node:fs';

const LOG_PATH =
  process.env.AI_COLLEAGUE_ACTIVITY_LOG ?? '/tmp/ai-colleague-activity.jsonl';

export type ActivityStatus = 'ok' | 'error' | 'blocked';

export interface ActivityRecord {
  ts: string;
  source: string;
  tool: string;
  status: ActivityStatus;
  tab?: string;
  detail?: string;
  error?: string;
}

const SOURCE = process.env.AI_COLLEAGUE_ACTIVITY_SOURCE ?? 'appium-mcp';

export function logActivity(args: {
  tool: string;
  status?: ActivityStatus;
  tab?: string;
  detail?: string;
  error?: string;
}): void {
  const record: ActivityRecord = {
    ts: new Date().toISOString(),
    source: SOURCE,
    tool: args.tool,
    status: args.status ?? 'ok',
    ...(args.tab !== undefined ? { tab: args.tab } : {}),
    ...(args.detail !== undefined
      ? { detail: truncate(args.detail, 200) }
      : {}),
    ...(args.error !== undefined ? { error: truncate(args.error, 300) } : {}),
  };
  try {
    appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Silent — log file is purely advisory.
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
