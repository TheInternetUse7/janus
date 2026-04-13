import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEvent, DeliveryJobData } from '../../src/types/canonical';

const {
  mockCheckRateLimit,
  mockGetRateLimitDelay,
  mockRegisterOutgoingHash,
  mockBridgePairFindUnique,
  mockMessageMapCreate,
  mockMessageMapFindFirst,
  mockMessageMapUpdate,
  mockMessageMapDelete,
  mockAxiosGet,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockGetRateLimitDelay: vi.fn(),
  mockRegisterOutgoingHash: vi.fn(),
  mockBridgePairFindUnique: vi.fn(),
  mockMessageMapCreate: vi.fn(),
  mockMessageMapFindFirst: vi.fn(),
  mockMessageMapUpdate: vi.fn(),
  mockMessageMapDelete: vi.fn(),
  mockAxiosGet: vi.fn(),
}));

vi.mock('bullmq', () => {
  class Worker {
    constructor(..._args: unknown[]) {}
    on() {
      return this;
    }
    async close(): Promise<void> {}
  }

  return { Worker };
});

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
  },
}));

vi.mock('../../src/lib/rateLimiter', () => ({
  checkRateLimit: mockCheckRateLimit,
  getRateLimitDelay: mockGetRateLimitDelay,
}));

vi.mock('../../src/lib/loopFilter', () => ({
  registerOutgoingHash: mockRegisterOutgoingHash,
}));

vi.mock('../../src/lib/database', () => ({
  prisma: {
    bridgePair: {
      findUnique: mockBridgePairFindUnique,
    },
    messageMap: {
      create: mockMessageMapCreate,
      findFirst: mockMessageMapFindFirst,
      update: mockMessageMapUpdate,
      delete: mockMessageMapDelete,
    },
  },
}));

import { FluxerDeliveryWorker } from '../../src/workers/fluxer-delivery';

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    type: 'MSG_CREATE',
    content: '',
    author: {
      name: 'alice',
      avatar: 'https://cdn.example.com/alice.png',
    },
    source: {
      platform: 'discord',
      messageId: 'source-msg-1',
      channelId: 'source-chan',
      guildId: 'source-guild',
    },
    reference: null,
    attachments: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeJob(data: DeliveryJobData): { data: DeliveryJobData; moveToDelayed: ReturnType<typeof vi.fn> } {
  return {
    data,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  };
}

const webhookBridge = {
  id: 'pair-1',
  fluxerGuildId: 'fluxer-target-guild',
  fluxerWebhookId: 'fluxer-webhook-1',
  fluxerWebhookToken: 'fluxer-token-1',
};

describe('fluxer delivery worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockGetRateLimitDelay.mockResolvedValue(0);
    mockBridgePairFindUnique.mockResolvedValue(webhookBridge);
    mockMessageMapFindFirst.mockResolvedValue(null);
  });

  it('delivers attachment-only messages when upload succeeds', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: new Uint8Array([10, 11, 12]).buffer,
    });

    const sendWebhook = vi.fn().mockResolvedValue('fluxer-dest-1');
    const client = {
      sendWebhook,
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          attachments: [
            {
              url: 'https://files.example.com/photo.png',
              filename: 'photo.png',
              contentType: 'image/png',
              size: 3,
            },
          ],
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'fluxer',
        targetChannelId: 'fluxer-target-channel',
        targetGuildId: 'fluxer-target-guild',
        syncUploads: true,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    const call = sendWebhook.mock.calls[0];
    expect(call[2]).toBe('');
    expect(call[5]).toBe('fluxer-target-channel');
    expect(call[6]).toHaveLength(1);
    expect(call[6][0].name).toBe('photo.png');
    expect(mockMessageMapCreate).toHaveBeenCalledTimes(1);
    expect(mockRegisterOutgoingHash).toHaveBeenCalledWith(
      'https://files.example.com/photo.png',
      'alice'
    );
  });

  it('falls back to attachment links when upload fails', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('download failed'));

    const sendWebhook = vi.fn().mockResolvedValue('fluxer-dest-2');
    const client = {
      sendWebhook,
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          attachments: [
            {
              url: 'https://files.example.com/report.pdf',
              filename: 'report.pdf',
              contentType: 'application/pdf',
              size: 10,
            },
          ],
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'fluxer',
        targetChannelId: 'fluxer-target-channel',
        targetGuildId: 'fluxer-target-guild',
        syncUploads: true,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    const call = sendWebhook.mock.calls[0];
    expect(call[2]).toContain('-# [Attachment: report.pdf](https://files.example.com/report.pdf)');
    expect(call[6]).toEqual([]);
  });

  it('appends reply footer when reply mapping exists on create', async () => {
    mockMessageMapFindFirst.mockResolvedValueOnce({ destMsgId: 'fluxer-reply-dest-1' });

    const sendWebhook = vi.fn().mockResolvedValue('fluxer-dest-3');
    const client = {
      sendWebhook,
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          content: 'hello',
          reference: { messageId: 'reply-source-1' },
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'fluxer',
        targetChannelId: 'fluxer-target-channel',
        targetGuildId: 'fluxer-target-guild',
        syncUploads: false,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(sendWebhook.mock.calls[0][2]).toBe(
      'hello\n-# Reply to: [message link](https://fluxer.app/channels/fluxer-target-guild/fluxer-target-channel/fluxer-reply-dest-1)'
    );
  });

  it('keeps plain content when reply mapping is missing', async () => {
    mockMessageMapFindFirst.mockResolvedValue(null);

    const sendWebhook = vi.fn().mockResolvedValue('fluxer-dest-4');
    const client = {
      sendWebhook,
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          content: 'hello',
          reference: { messageId: 'reply-source-2' },
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'fluxer',
        targetChannelId: 'fluxer-target-channel',
        targetGuildId: 'fluxer-target-guild',
        syncUploads: false,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(sendWebhook.mock.calls[0][2]).toBe('hello');
  });

  it('edits mirrored webhook messages in place on updates and preserves reply footer', async () => {
    mockMessageMapFindFirst
      .mockResolvedValueOnce({ id: 'map-1', destMsgId: 'fluxer-old-target-1' })
      .mockResolvedValueOnce({ destMsgId: 'fluxer-reply-dest-2' });

    const editWebhookMessage = vi.fn().mockResolvedValue(undefined);
    const client = {
      sendWebhook: vi.fn(),
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      editWebhookMessage,
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          type: 'MSG_UPDATE',
          content: 'edited content',
          reference: { messageId: 'reply-source-3' },
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'fluxer',
        targetChannelId: 'fluxer-target-channel',
        targetGuildId: 'fluxer-target-guild',
        syncUploads: false,
      })
    );

    expect(editWebhookMessage).toHaveBeenCalledTimes(1);
    expect(editWebhookMessage).toHaveBeenCalledWith(
      'fluxer-webhook-1',
      'fluxer-token-1',
      'fluxer-old-target-1',
      'edited content\n-# Reply to: [message link](https://fluxer.app/channels/fluxer-target-guild/fluxer-target-channel/fluxer-reply-dest-2)'
    );
    expect(client.sendWebhook).not.toHaveBeenCalled();
    expect(client.deleteMessage).not.toHaveBeenCalled();
    expect(mockMessageMapUpdate).not.toHaveBeenCalled();
  });

  it('skips truly empty create events', async () => {
    const sendWebhook = vi.fn();
    const client = {
      sendWebhook,
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent(),
        bridgePairId: 'pair-1',
        targetPlatform: 'fluxer',
        targetChannelId: 'fluxer-target-channel',
        targetGuildId: 'fluxer-target-guild',
        syncUploads: false,
      })
    );

    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it('throws when Fluxer webhook delivery fails so BullMQ can retry', async () => {
    const sendWebhook = vi.fn().mockResolvedValue(null);
    const client = {
      sendWebhook,
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await expect(
      worker.processJob(
        makeJob({
          event: makeEvent({ content: 'hello' }),
          bridgePairId: 'pair-1',
          targetPlatform: 'fluxer',
          targetChannelId: 'fluxer-target-channel',
          targetGuildId: 'fluxer-target-guild',
          syncUploads: false,
        })
      )
    ).rejects.toThrow('Failed to deliver message to Fluxer');
  });

  it('throws when Fluxer webhook edits fail so BullMQ can retry', async () => {
    mockMessageMapFindFirst.mockResolvedValueOnce({ id: 'map-1', destMsgId: 'fluxer-old-target-1' });

    const editWebhookMessage = vi.fn().mockRejectedValue(new Error('edit failed'));
    const client = {
      sendWebhook: vi.fn(),
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      editWebhookMessage,
      deleteMessage: vi.fn(),
    };

    const worker = new FluxerDeliveryWorker(client as any, 'fluxer-target-channel');

    await expect(
      worker.processJob(
        makeJob({
          event: makeEvent({
            type: 'MSG_UPDATE',
            content: 'edited content',
          }),
          bridgePairId: 'pair-1',
          targetPlatform: 'fluxer',
          targetChannelId: 'fluxer-target-channel',
          targetGuildId: 'fluxer-target-guild',
          syncUploads: false,
        })
      )
    ).rejects.toThrow('edit failed');
  });
});
