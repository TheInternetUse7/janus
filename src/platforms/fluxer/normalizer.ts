import type {
  CanonicalEvent,
  CanonicalEventType,
  CanonicalAuthor,
  CanonicalAttachment,
} from '../../types/canonical';
import type { FluxerMessage } from '../fluxer/client';

/**
 * Convert Fluxer avatar hash to full CDN URL
 * Fluxer avatars are stored as hashes and need to be converted to full URLs
 */
function buildFluxerAvatarUrl(userId: string, avatarHash: string | null): string | null {
  if (!avatarHash) return null;

  // If it's already a full URL, return it as-is
  if (avatarHash.startsWith('http://') || avatarHash.startsWith('https://')) {
    return avatarHash;
  }

  // Build the Fluxer CDN URL
  // Format: https://cdn.fluxer.app/avatars/{userId}/{hash}.png
  return `https://cdn.fluxer.app/avatars/${userId}/${avatarHash}.png`;
}

export function normalizeToCanonical(
  event: FluxerMessage,
  type: CanonicalEventType
): CanonicalEvent {
  const author: CanonicalAuthor = {
    name: event.author.name,
    avatar: buildFluxerAvatarUrl(event.author.id, event.author.avatar),
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
