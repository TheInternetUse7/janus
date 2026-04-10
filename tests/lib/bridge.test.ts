import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBridgePairDelete, mockMessageMapDeleteMany, mockTransaction } = vi.hoisted(() => ({
  mockBridgePairDelete: vi.fn(),
  mockMessageMapDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock('../../src/lib/database', () => ({
  prisma: {
    bridgePair: {
      delete: mockBridgePairDelete,
    },
    messageMap: {
      deleteMany: mockMessageMapDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));

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
});
