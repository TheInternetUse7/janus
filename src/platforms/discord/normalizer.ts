import type { CanonicalEvent, CanonicalEventType, CanonicalAuthor, CanonicalAttachment } from '../../types/canonical';
import type { DiscordMessageEvent } from './client';

export function normalizeToCanonical(event: DiscordMessageEvent, type: CanonicalEventType): CanonicalEvent {
  const author: CanonicalAuthor = {
    name: event.author.username,
    avatar: event.author.avatar,
  };

  const attachments: CanonicalAttachment[] = event.attachments.map((att) => ({
    url: att.url,
    filename: att.filename,
    contentType: att.contentType,
    size: att.size,
  }));

  return {
    type,
    content: event.content,
    author,
    source: {
      platform: 'discord',
      messageId: event.id,
      channelId: event.channelId,
      guildId: event.guildId,
    },
    attachments,
    timestamp: new Date(event.timestamp).getTime(),
  };
}
