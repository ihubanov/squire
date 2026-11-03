/**
 * The user's own browser activity is reported to the AI; the AI's own
 * actions are not.
 */
import { describe, test, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  watchUserActivity,
  beginAction,
  endAction,
  takeUserEvents,
  formatUserEvents,
  waitForUserEvent,
} from '../user-activity.js';

function fakeContext() {
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://example.com/a',
    mainFrame: () => ({}),
    evaluate: async () => {},
  });
  const ctx = Object.assign(new EventEmitter(), {
    addInitScript: async () => {},
    pages: () => [page],
  });
  return {
    ctx,
    // What the in-page listener sends for a user action.
    userDoes: (kind: string, detail: string) =>
      page.emit('console', {
        type: () => 'debug',
        text: () => '\u2063squire-user ' + JSON.stringify({ kind, detail }),
      }),
  };
}

describe('user activity', () => {
  test('reports what the user did, not what Squire did', async () => {
    const { ctx, userDoes } = fakeContext();
    await watchUserActivity(ctx as never);
    takeUserEvents();
    beginAction();
    userDoes('clicked', 'button "Squire did this"');
    endAction();
    await new Promise((r) => setTimeout(r, 450));
    userDoes('clicked', 'button "Save"');
    const seen = takeUserEvents();
    expect(seen.map((e) => e.detail)).toEqual(['button "Save"']);
    expect(formatUserEvents(seen)).toMatch(/clicked button "Save" \(example\.com\/a\)/);
    expect(takeUserEvents()).toEqual([]);
  });

  test('waitForUserEvent returns as soon as the user acts', async () => {
    const { ctx, userDoes } = fakeContext();
    await watchUserActivity(ctx as never);
    takeUserEvents();
    const start = Date.now();
    setTimeout(() => userDoes('pressed Enter in', 'input "Search"'), 100);
    await waitForUserEvent(5000);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(takeUserEvents()).toHaveLength(1);
  });
});
