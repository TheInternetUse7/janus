import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWebhookSend, mockWebhookFromToken } = vi.hoisted(() => ({
  mockWebhookSend: vi.fn(),
  mockWebhookFromToken: vi.fn(),
}));

vi.mock('@fluxerjs/core', () => {
  class MockClient {
    public handlers = new Map<string | symbol, (...args: any[]) => any>();
    public user = { username: 'janus' };
    public rest = {
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
    };

    constructor(_options: unknown) {}

    on(event: string | symbol, handler: (...args: any[]) => any) {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: string | symbol, ...args: any[]) {
      return this.handlers.get(event)?.(...args);
    }

    async login() {}
    destroy() {}
  }

  return {
    Client: MockClient,
    Events: {
      Ready: 'ready',
      MessageCreate: 'messageCreate',
      MessageUpdate: 'messageUpdate',
      MessageDelete: 'messageDelete',
      Error: 'error',
    },
    Routes: {},
    Webhook: {
      fromToken: mockWebhookFromToken,
    },
  };
});

vi.mock('../../../src/lib/bridge', () => ({
  bridgeService: {
    createBridge: vi.fn(),
    listBridges: vi.fn(),
    deleteBridge: vi.fn(),
    toggleBridge: vi.fn(),
  },
}));

import { FluxerClient } from '../../../src/platforms/fluxer/client';

describe('fluxer client webhook sending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses webhook.send without wait=true and passes channelId to fromToken', async () => {
    mockWebhookSend.mockResolvedValueOnce(undefined);
    mockWebhookFromToken.mockReturnValueOnce({
      send: mockWebhookSend,
    });

    const client = new FluxerClient();
    const sendPromise = client.sendWebhook(
      'webhook-1',
      'token-1',
      'hello',
      'alice',
      'https://cdn.example.com/alice.png',
      'channel-1'
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const internalClient = (client as any).client;
    (internalClient as any).emit('messageCreate', {
      id: 'message-1',
      channelId: 'channel-1',
      content: 'hello',
      author: {
        username: 'alice',
      },
    });

    const messageId = await sendPromise;

    expect(mockWebhookFromToken).toHaveBeenCalledWith(
      internalClient,
      'webhook-1',
      'token-1',
      { channelId: 'channel-1' }
    );
    expect(mockWebhookSend).toHaveBeenCalledWith({
      username: 'alice',
      content: 'hello',
      avatar_url: 'https://cdn.example.com/alice.png',
    });
    expect(messageId).toBe('message-1');
  });
});
