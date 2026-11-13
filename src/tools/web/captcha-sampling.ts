/**
 * Vision half of the reCAPTCHA grid solver, answered by the MCP client.
 *
 * When no local vision endpoint is configured (see captcha-vision.ts) but
 * the client advertises MCP sampling, the grid is sent back to the client
 * with `sampling/createMessage` and an image content block. The client's
 * own main model then answers the tiles, so the solver works with no
 * machine configuration at all. A client that does not advertise sampling
 * (or whose session cannot be found) leaves the tool returning
 * `needs_answer`, exactly as before.
 */
import type { Context, FastMCP, FastMCPSession } from 'fastmcp';

/** One classification request, answered by the client's model. */
export type SampleRequest = {
  /** Instructions plus the challenge text. */
  instruction: string;
  /** The image as a data URL (data:image/png;base64,…). */
  image: string;
  maxTokens: number;
};

/** Returns the model's raw reply, or null when sampling is unavailable/fails. */
export type TileSampler = (request: SampleRequest) => Promise<string | null>;

/** Optional sink for why a sampling attempt failed, for the caller's log. */
export type SampleNote = (message: string) => void;

/**
 * The session whose client should answer. The tool context only carries the
 * auth object, so pick by session id when the transport provides one, and
 * otherwise use the only ready session (the common stdio case: one Squire
 * process per client). With several sessions and no id, take the single one
 * that advertised sampling; ambiguity means "no sampler" rather than asking
 * the wrong client's model.
 */
function pickSession(
  server: FastMCP,
  ctx: Context<any> | undefined
): FastMCPSession | undefined {
  let sessions: FastMCPSession[];
  try {
    sessions = (server.sessions ?? []).filter((s) => s.isReady);
  } catch {
    return undefined;
  }
  if (ctx?.sessionId) {
    const match = sessions.find((s) => s.sessionId === ctx.sessionId);
    if (match) {
      return match;
    }
  }
  if (sessions.length === 1) {
    return sessions[0];
  }
  const samplingClients = sessions.filter(
    (s) => s.clientCapabilities?.sampling !== undefined
  );
  return samplingClients.length === 1 ? samplingClients[0] : undefined;
}

function splitDataUrl(
  image: string
): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(image);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/**
 * A TileSampler backed by MCP sampling on the calling client, or undefined
 * when the client does not support sampling or no session can be identified.
 */
export function makeSamplingSampler(
  server: FastMCP,
  ctx: Context<any> | undefined,
  note?: SampleNote
): TileSampler | undefined {
  const session = pickSession(server, ctx);
  if (!session || session.clientCapabilities?.sampling === undefined) {
    return undefined;
  }
  const target = session;
  return async (request) => {
    const image = splitDataUrl(request.image);
    if (!image) {
      note?.('sampling: challenge image is not a base64 data URL');
      return null;
    }
    try {
      const result = await target.requestSampling(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: request.instruction },
                { type: 'image', data: image.data, mimeType: image.mimeType },
              ],
            },
          ],
          maxTokens: request.maxTokens,
          temperature: 0,
        },
        // reCAPTCHA challenges expire; a stalled client must not eat the
        // whole solve budget.
        { timeout: 60_000 }
      );
      if (result.content?.type === 'text') {
        const text = result.content.text;
        return typeof text === 'string' && text.trim() ? text : null;
      }
      note?.(
        `sampling: client returned ${result.content?.type ?? 'no'} content`
      );
      return null;
    } catch (err: any) {
      note?.(`sampling request failed: ${err?.message ?? err}`);
      return null;
    }
  };
}
