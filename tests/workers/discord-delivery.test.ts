import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEvent, DeliveryJobData } from '../../src/types/canonical';

const {
  mockCheckRateLimit,
  mockGetRateLimitDelay,
  mockRegisterOutgoingHash,
  mockMessageMapCreate,
  mockMessageMapFindFirst,
  mockMessageMapDelete,
  mockMessageMapUpdate,
  mockAxiosGet,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockGetRateLimitDelay: vi.fn(),
  mockRegisterOutgoingHash: vi.fn(),
  mockMessageMapCreate: vi.fn(),
  mockMessageMapFindFirst: vi.fn(),
  mockMessageMapDelete: vi.fn(),
  mockMessageMapUpdate: vi.fn(),
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
    messageMap: {
      create: mockMessageMapCreate,
      findFirst: mockMessageMapFindFirst,
      delete: mockMessageMapDelete,
      update: mockMessageMapUpdate,
    },
  },
}));

import { DiscordDeliveryWorker } from '../../src/workers/discord-delivery';

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    type: 'MSG_CREATE',
    content: '',
    author: {
      name: 'alice',
      avatar: 'https://cdn.example.com/alice.png',
    },
    source: {
      platform: 'fluxer',
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

describe('discord delivery worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockGetRateLimitDelay.mockResolvedValue(0);
    mockMessageMapFindFirst.mockResolvedValue(null);
  });

  it('delivers attachment-only messages when upload succeeds', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: new Uint8Array([1, 2, 3]).buffer,
    });

    const sendWebhook = vi.fn().mockResolvedValue('dest-msg-1');
    const client = {
      sendWebhook,
      editWebhookMessage: vi.fn(),
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

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
        targetPlatform: 'discord',
        targetChannelId: 'discord-target-channel',
        targetGuildId: 'discord-target-guild',
        discordWebhookId: 'webhook-1',
        discordWebhookToken: 'token-1',
        syncUploads: true,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    const call = sendWebhook.mock.calls[0];
    expect(call[2]).toBe('');
    expect(call[5]).toHaveLength(1);
    expect(call[5][0].name).toBe('photo.png');
    expect(mockMessageMapCreate).toHaveBeenCalledTimes(1);
    expect(mockRegisterOutgoingHash).toHaveBeenCalledWith(
      'https://files.example.com/photo.png',
      'alice'
    );
  });

  it('falls back to attachment links when upload fails', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('download failed'));

    const sendWebhook = vi.fn().mockResolvedValue('dest-msg-2');
    const client = {
      sendWebhook,
      editWebhookMessage: vi.fn(),
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

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
        targetPlatform: 'discord',
        targetChannelId: 'discord-target-channel',
        targetGuildId: 'discord-target-guild',
        discordWebhookId: 'webhook-1',
        discordWebhookToken: 'token-1',
        syncUploads: true,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    const call = sendWebhook.mock.calls[0];
    expect(call[2]).toContain('-# [Attachment: report.pdf](https://files.example.com/report.pdf)');
    expect(call[5]).toEqual([]);
  });

  it('appends reply footer when reply mapping exists on create', async () => {
    mockMessageMapFindFirst.mockResolvedValueOnce({ destMsgId: 'discord-reply-dest-1' });

    const sendWebhook = vi.fn().mockResolvedValue('dest-msg-3');
    const client = {
      sendWebhook,
      editWebhookMessage: vi.fn(),
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          content: 'hello',
          reference: { messageId: 'reply-source-1' },
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'discord',
        targetChannelId: 'discord-target-channel',
        targetGuildId: 'discord-target-guild',
        discordWebhookId: 'webhook-1',
        discordWebhookToken: 'token-1',
        syncUploads: false,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(sendWebhook.mock.calls[0][2]).toBe(
      'hello\n-# Reply to: [message link](https://discord.com/channels/discord-target-guild/discord-target-channel/discord-reply-dest-1)'
    );
  });

  it('keeps plain content when reply mapping is missing', async () => {
    mockMessageMapFindFirst.mockResolvedValue(null);

    const sendWebhook = vi.fn().mockResolvedValue('dest-msg-4');
    const client = {
      sendWebhook,
      editWebhookMessage: vi.fn(),
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          content: 'hello',
          reference: { messageId: 'reply-source-2' },
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'discord',
        targetChannelId: 'discord-target-channel',
        targetGuildId: 'discord-target-guild',
        discordWebhookId: 'webhook-1',
        discordWebhookToken: 'token-1',
        syncUploads: false,
      })
    );

    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(sendWebhook.mock.calls[0][2]).toBe('hello');
  });

  it('preserves reply footer on webhook edits', async () => {
    mockMessageMapFindFirst
      .mockResolvedValueOnce({ id: 'map-1', destMsgId: 'discord-edited-target-1' })
      .mockResolvedValueOnce({ destMsgId: 'discord-reply-dest-2' });

    const editWebhookMessage = vi.fn().mockResolvedValue(true);
    const client = {
      sendWebhook: vi.fn(),
      editWebhookMessage,
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent({
          type: 'MSG_UPDATE',
          content: 'edited content',
          reference: { messageId: 'reply-source-3' },
        }),
        bridgePairId: 'pair-1',
        targetPlatform: 'discord',
        targetChannelId: 'discord-target-channel',
        targetGuildId: 'discord-target-guild',
        discordWebhookId: 'webhook-1',
        discordWebhookToken: 'token-1',
        syncUploads: false,
      })
    );

    expect(editWebhookMessage).toHaveBeenCalledTimes(1);
    expect(editWebhookMessage).toHaveBeenCalledWith(
      'webhook-1',
      'token-1',
      'discord-edited-target-1',
      'edited content\n-# Reply to: [message link](https://discord.com/channels/discord-target-guild/discord-target-channel/discord-reply-dest-2)'
    );
  });

  it('skips truly empty create events', async () => {
    const sendWebhook = vi.fn();
    const client = {
      sendWebhook,
      editWebhookMessage: vi.fn(),
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

    await worker.processJob(
      makeJob({
        event: makeEvent(),
        bridgePairId: 'pair-1',
        targetPlatform: 'discord',
        targetChannelId: 'discord-target-channel',
        targetGuildId: 'discord-target-guild',
        discordWebhookId: 'webhook-1',
        discordWebhookToken: 'token-1',
        syncUploads: false,
      })
    );

    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it('throws when Discord webhook delivery fails so BullMQ can retry', async () => {
    const sendWebhook = vi.fn().mockResolvedValue(null);
    const client = {
      sendWebhook,
      editWebhookMessage: vi.fn(),
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

    await expect(
      worker.processJob(
        makeJob({
          event: makeEvent({ content: 'hello' }),
          bridgePairId: 'pair-1',
          targetPlatform: 'discord',
          targetChannelId: 'discord-target-channel',
          targetGuildId: 'discord-target-guild',
          discordWebhookId: 'webhook-1',
          discordWebhookToken: 'token-1',
          syncUploads: false,
        })
      )
    ).rejects.toThrow('Failed to deliver message to Discord');
  });

  it('throws when Discord webhook edit fails so BullMQ can retry', async () => {
    mockMessageMapFindFirst.mockResolvedValueOnce({ id: 'map-1', destMsgId: 'discord-target-1' });

    const client = {
      sendWebhook: vi.fn(),
      editWebhookMessage: vi.fn().mockResolvedValue(false),
      deleteWebhookMessage: vi.fn(),
    };

    const worker = new DiscordDeliveryWorker(client as any, 'discord-target-channel');

    await expect(
      worker.processJob(
        makeJob({
          event: makeEvent({
            type: 'MSG_UPDATE',
            content: 'edited content',
          }),
          bridgePairId: 'pair-1',
          targetPlatform: 'discord',
          targetChannelId: 'discord-target-channel',
          targetGuildId: 'discord-target-guild',
          discordWebhookId: 'webhook-1',
          discordWebhookToken: 'token-1',
          syncUploads: false,
        })
      )
    ).rejects.toThrow('Failed to update message on Discord');
  });
});
