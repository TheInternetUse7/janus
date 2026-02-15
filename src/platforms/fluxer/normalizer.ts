import type { CanonicalEvent, CanonicalEventType, CanonicalAuthor, CanonicalAttachment } from '../../types/canonical';
import type { FluxerMessage } from '../fluxer/client';

export function normalizeToCanonical(event: FluxerMessage, type: CanonicalEventType): CanonicalEvent {
  const author: CanonicalAuthor = {
    name: event.author.name,
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
      platform: 'fluxer',
      messageId: event.id,
      channelId: event.channelId,
      guildId: event.guildId ?? null,
    },
    attachments,
    timestamp: new Date(event.timestamp).getTime(),
  };
}
