/**
 * Guard for hosts that own one or more "protected" tabs in a CDP-attached
 * Chromium — typically a TUI tab the AI lives inside (e.g. ai-colleague's
 * qwen-web at http://127.0.0.1:3901). If the AI tries to navigate, close,
 * or otherwise mutate such a tab the host's session would die mid-flight.
 *
 * Configured via the APPIUM_MCP_PROTECTED_URL_PREFIXES env var: a
 * comma-separated list of URL prefixes. Matching is case-insensitive on the
 * scheme+host+port+path-prefix.
 */

export function getProtectedPrefixes(): string[] {
  const raw = process.env.APPIUM_MCP_PROTECTED_URL_PREFIXES ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isProtectedUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  const prefixes = getProtectedPrefixes();
  if (prefixes.length === 0) {
    return false;
  }
  const lower = url.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p.toLowerCase()));
}

export function assertNotProtected(url: string, action: string): void {
  if (isProtectedUrl(url)) {
    const msg =
      `Refusing to ${action} on tab "${url}" — it matches a protected URL prefix ` +
      `(APPIUM_MCP_PROTECTED_URL_PREFIXES). This tab belongs to the host ` +
      `application (e.g. the qwen-web TUI you are running inside). ` +
      `Open a new tab with playwright_new_tab(url) instead, or switch to a ` +
      `different existing tab with playwright_switch_tab(index) first.`;
    // Lazy import to avoid a circular module load at bootstrap.
    import('./activity-log.js')
      .then(({ logActivity }) =>
        logActivity({
          tool: action,
          tab: url,
          status: 'blocked',
          detail: 'protected URL',
        })
      )
      .catch(() => {
        /* ignore */
      });
    throw new Error(msg);
  }
}
