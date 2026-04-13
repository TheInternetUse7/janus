import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockBridgePairDelete,
  mockBridgePairFindUnique,
  mockBridgePairUpdate,
  mockMessageMapDeleteMany,
  mockTransaction,
} = vi.hoisted(() => ({
  mockBridgePairDelete: vi.fn(),
  mockBridgePairFindUnique: vi.fn(),
  mockBridgePairUpdate: vi.fn(),
  mockMessageMapDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock('../../src/lib/database', () => ({
  prisma: {
    bridgePair: {
      delete: mockBridgePairDelete,
      findUnique: mockBridgePairFindUnique,
      update: mockBridgePairUpdate,
    },
    messageMap: {
      deleteMany: mockMessageMapDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock('../../src/platforms/discord/client', () => {
  class DiscordApiError extends Error {
    code?: number;
    status?: number;

    constructor(message: string, options?: { code?: number; status?: number }) {
      super(message);
      this.code = options?.code;
      this.status = options?.status;
    }
  }

  return { DiscordApiError };
});

import { BridgeService } from '../../src/lib/bridge';

describe('bridge service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes dependent message mappings before deleting a bridge', async () => {
    const bridge = { id: 'bridge-1', discordChannelId: 'discord-1', fluxerChannelId: 'fluxer-1' };

    mockMessageMapDeleteMany.mockReturnValueOnce(Promise.resolve({ count: 3 }));
    mockBridgePairDelete.mockReturnValueOnce(Promise.resolve(bridge));
    mockTransaction.mockResolvedValueOnce([{ count: 3 }, bridge]);

    const service = new BridgeService();
    const deletedHandler = vi.fn();
    service.on('bridge:deleted', deletedHandler);

    const result = await service.deleteBridge('bridge-1');

    expect(mockMessageMapDeleteMany).toHaveBeenCalledWith({
      where: { pairId: 'bridge-1' },
    });
    expect(mockBridgePairDelete).toHaveBeenCalledWith({
      where: { id: 'bridge-1' },
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual(bridge);
    expect(deletedHandler).toHaveBeenCalledWith('bridge-1');
  });

  it('deactivates a bridge when Discord webhook repair fails with missing access', async () => {
    const { DiscordApiError } = await import('../../src/platforms/discord/client');

    mockBridgePairFindUnique.mockResolvedValueOnce({
      id: 'bridge-2',
      discordChannelId: 'discord-2',
      fluxerChannelId: 'fluxer-2',
      discordWebhookId: null,
      discordWebhookToken: null,
      fluxerWebhookId: 'fluxer-webhook-1',
      fluxerWebhookToken: 'fluxer-token-1',
      isActive: true,
    });
    mockBridgePairUpdate.mockResolvedValueOnce({
      id: 'bridge-2',
      isActive: false,
    });

    const service = new BridgeService();
    const client = {
      createWebhook: vi
        .fn()
        .mockRejectedValueOnce(new DiscordApiError('Missing Access', { code: 50001, status: 403 })),
    };

    const bridgeModule = await import('../../src/lib/bridge');
    bridgeModule.setDiscordClient(client as any);

    const result = await service.repairBridgeWebhook('bridge-2');

    expect(mockBridgePairUpdate).toHaveBeenCalledWith({
      where: { id: 'bridge-2' },
      data: { isActive: false },
    });
    expect(result).toEqual({
      id: 'bridge-2',
      isActive: false,
    });
  });
});
