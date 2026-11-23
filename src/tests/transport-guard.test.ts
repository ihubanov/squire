import { describe, expect, it, jest } from '@jest/globals';
import { Writable } from 'node:stream';
import {
  createTransportErrorHandler,
  isTransportError,
} from '../transport-guard.js';

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

/** Every write fails the way a write to an orphaned socketpair does. */
class DeadStdio extends Writable {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _write(_chunk: unknown, _encoding: unknown, callback: (e?: Error) => void) {
    callback(epipe());
  }
}

describe('transport guard', () => {
  it('recognises the codes a vanished client raises', () => {
    expect(isTransportError(epipe())).toBe(true);
    expect(
      isTransportError(
        Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' })
      )
    ).toBe(true);
    expect(isTransportError(new Error('Chrome 155 shared_worker'))).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });

  it('cannot spin: repeated dead writes reach onClientGone exactly once', async () => {
    const onClientGone = jest.fn();
    const stream = new DeadStdio();
    stream.on(
      'error',
      createTransportErrorHandler({ useHttpStream: false, onClientGone })
    );

    for (let i = 0; i < 100; i++) {
      stream.write('log line');
    }
    // Stream errors are delivered asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onClientGone).toHaveBeenCalledTimes(1);
  });

  it('keeps an httpStream server alive when its log sink dies', () => {
    const onClientGone = jest.fn();
    const handle = createTransportErrorHandler({
      useHttpStream: true,
      onClientGone,
    });

    expect(() => handle(epipe())).not.toThrow();
    expect(onClientGone).not.toHaveBeenCalled();
  });
});
