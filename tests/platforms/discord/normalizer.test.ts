import { describe, expect, it } from 'vitest';
import { normalizeToCanonical } from '../../../src/platforms/discord/normalizer';
import type { DiscordMessageEvent } from '../../../src/platforms/discord/client';

describe('discord normalizer', () => {
  it('maps discord events to canonical shape', () => {
    const input: DiscordMessageEvent = {
      id: 'msg-1',
      channelId: 'chan-1',
      guildId: 'guild-1',
      content: 'hello from discord',
      author: {
        id: 'author-1',
        username: 'alice',
        bot: false,
        avatar: 'https://cdn.discordapp.com/avatar.png',
      },
      attachments: [
        {
          url: 'https://example.com/file.txt',
          filename: 'file.txt',
          contentType: 'text/plain',
          size: 12,
        },
      ],
      editedAt: null,
      timestamp: '2026-02-17T12:34:56.000Z',
    };

    const output = normalizeToCanonical(input, 'MSG_CREATE');

    expect(output).toEqual({
      type: 'MSG_CREATE',
      content: 'hello from discord',
      author: {
        name: 'alice',
        avatar: 'https://cdn.discordapp.com/avatar.png',
      },
      source: {
        platform: 'discord',
        messageId: 'msg-1',
        channelId: 'chan-1',
        guildId: 'guild-1',
      },
      attachments: [
        {
          url: 'https://example.com/file.txt',
          filename: 'file.txt',
          contentType: 'text/plain',
          size: 12,
        },
      ],
      timestamp: 1771331696000,
    });
  });
});
