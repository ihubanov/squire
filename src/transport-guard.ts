// Everything an MCP stdio server says goes to the client's end of
// stdin/stdout/stderr. When that client goes away, the next write fails with
// EPIPE (SIGPIPE is ignored, so it surfaces as an 'error' event instead of
// killing us). Without an 'error' listener Node throws that into
// `uncaughtException`, and the keep-alive handler in index.ts logs the failure
// straight back into the same dead stream — a re-entrant loop.
//
// That is not theoretical: an orphaned server (PID 3926556, @sniffski/squire
// 1.34.16) wrote to a dead stderr at ~3,000 calls/second, 0 bytes delivered,
// for 3.6 days at 99.6% of a core. It ignored SIGTERM because shutdown logs
// through the same stream, and needed SIGKILL.
//
// A transport error means there is no client left to serve, so the only sane
// answer is to leave through the normal shutdown path — once.

export const TRANSPORT_ERROR_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

export function isTransportError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code);
}

export interface TransportGuardOptions {
  /**
   * HTTP-stream servers keep serving over TCP; a dead log sink must not take
   * them down, so the error is swallowed instead of ending the process.
   */
  useHttpStream: boolean;
  /** Invoked at most once when the stdio client's transport is gone. */
  onClientGone: () => void;
}

/**
 * Builds the handler used both for `stdout`/`stderr` 'error' events and for
 * transport errors arriving through `uncaughtException`.
 *
 * Idempotent by design: the shutdown path logs through the same dead stream,
 * which emits more transport errors. Calling `onClientGone` again would either
 * re-enter shutdown or spin; swallowing the repeats is what breaks the loop.
 */
export function createTransportErrorHandler(
  options: TransportGuardOptions
): (error: unknown) => void {
  let clientGone = false;
  return (error: unknown): void => {
    if (options.useHttpStream) {
      return;
    }
    if (clientGone) {
      return;
    }
    clientGone = true;
    options.onClientGone();
  };
}

/** Installs the handler on the streams a client talks to. */
export function installStdioGuards(
  options: TransportGuardOptions
): (error: unknown) => void {
  const handler = createTransportErrorHandler(options);
  process.stdout.on('error', handler);
  process.stderr.on('error', handler);
  return handler;
}
