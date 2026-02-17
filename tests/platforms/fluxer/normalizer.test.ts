import { describe, expect, it } from 'vitest';
import { normalizeToCanonical } from '../../../src/platforms/fluxer/normalizer';
import type { FluxerMessage } from '../../../src/platforms/fluxer/client';

function baseMessage(avatar: string | null): FluxerMessage {
  return {
    id: 'flux-msg-1',
    channelId: 'flux-chan-1',
    guildId: null,
    content: 'hello from fluxer',
    author: {
      id: 'user-123',
      name: 'bob',
      avatar,
      bot: false,
    },
    attachments: [],
    timestamp: '2026-02-17T10:00:00.000Z',
    editedAt: null,
  };
}

describe('fluxer normalizer', () => {
  it('builds a Fluxer CDN avatar URL from avatar hash', () => {
    const output = normalizeToCanonical(baseMessage('abc123hash'), 'MSG_UPDATE');

    expect(output.author.avatar).toBe(
      'https://fluxerusercontent.com/avatars/user-123/abc123hash.png'
    );
    expect(output.source.guildId).toBeNull();
  });

  it('uses gif extension for animated avatars', () => {
    const output = normalizeToCanonical(baseMessage('a_animhash'), 'MSG_CREATE');

    expect(output.author.avatar).toBe(
      'https://fluxerusercontent.com/avatars/user-123/a_animhash.gif'
    );
  });

  it('keeps full avatar URLs unchanged', () => {
    const output = normalizeToCanonical(
      baseMessage('https://images.example.com/avatar.png'),
      'MSG_CREATE'
    );

    expect(output.author.avatar).toBe('https://images.example.com/avatar.png');
  });

  it('keeps avatar null when source avatar is null', () => {
    const output = normalizeToCanonical(baseMessage(null), 'MSG_CREATE');

    expect(output.author.avatar).toBeNull();
  });
});
