/**
 * MCP-sampling vision fallback: session selection, capability gating, data
 * URL conversion, and the pickTiles wiring. No network and no MCP transport.
 */
import { describe, test, expect } from '@jest/globals';
import { makeSamplingSampler } from '../tools/web/captcha-sampling.js';
import { pickTiles } from '../tools/web/captcha-vision.js';

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function fakeServer(reply: unknown, opts: { sampling?: boolean } = {}) {
  const calls: unknown[] = [];
  const server = {
    sessions: [
      {
        isReady: true,
        clientCapabilities: opts.sampling === false ? {} : { sampling: {} },
        requestSampling: async (params: unknown) => {
          calls.push(params);
          if (reply instanceof Error) {
            throw reply;
          }
          return reply;
        },
      },
    ],
  };
  return { server: server as any, calls };
}

describe('makeSamplingSampler', () => {
  test('returns undefined when the client does not advertise sampling', () => {
    const { server } = fakeServer(
      { content: { type: 'text', text: '{"select":[0]}' } },
      { sampling: false }
    );
    expect(makeSamplingSampler(server, {} as any)).toBeUndefined();
  });

  test('returns undefined when no session can be identified', () => {
    const server = { sessions: [] } as any;
    expect(makeSamplingSampler(server, {} as any)).toBeUndefined();
  });

  test('sends text plus the image and returns the reply text', async () => {
    const { server, calls } = fakeServer({
      model: 'client-model',
      role: 'assistant',
      content: { type: 'text', text: '{"select":[2,5]}' },
    });
    const sampler = makeSamplingSampler(server, {} as any)!;
    const reply = await sampler({
      instruction: 'pick tiles',
      image: IMAGE,
      maxTokens: 100,
    });
    expect(reply).toBe('{"select":[2,5]}');
    const params = calls[0] as any;
    expect(params.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'pick tiles',
    });
    expect(params.messages[0].content[1]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
    expect(params.maxTokens).toBe(100);
  });

  test('a failed request yields null, not a throw', async () => {
    const { server } = fakeServer(new Error('client said no'));
    const sampler = makeSamplingSampler(server, {} as any)!;
    expect(
      await sampler({ instruction: 'x', image: IMAGE, maxTokens: 10 })
    ).toBeNull();
  });
});

describe('pickTiles with a sampler', () => {
  test('parses the sampled reply into tile indices', async () => {
    const { server, calls } = fakeServer({
      content: { type: 'text', text: 'I choose {"select":[1,4]}' },
    });
    const sampler = makeSamplingSampler(server, {} as any);
    const picked = await pickTiles({
      sample: sampler,
      prompt: 'crosswalks',
      image: IMAGE,
      rows: 3,
      cols: 3,
    });
    expect(picked).toEqual([1, 4]);
    const instruction = (calls[0] as any).messages[0].content[0].text as string;
    expect(instruction).toContain('ROWS rows'.replace('ROWS', '3'));
    expect(instruction).toContain('Challenge instruction: "crosswalks"');
  });
});
