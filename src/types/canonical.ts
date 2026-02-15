/**
 * Canonical Event Types - Platform Agnostic
 * Janus does not know what "Discord" or "Fluxer" is until delivery time.
 */

export type Platform = 'discord' | 'fluxer';

export type CanonicalEventType = 'MSG_CREATE' | 'MSG_UPDATE' | 'MSG_DELETE';

export interface CanonicalAuthor {
  name: string;
  avatar: string | null;
}

export interface CanonicalAttachment {
  url: string;
  filename: string;
  contentType: string | null;
  size: number;
}

export interface CanonicalSource {
  platform: Platform;
  messageId: string;
  channelId: string;
  guildId: string | null;
}

export interface CanonicalEvent {
  type: CanonicalEventType;
  content: string;
  author: CanonicalAuthor;
  source: CanonicalSource;
  attachments: CanonicalAttachment[];
  timestamp: number; // Unix ms
}

/**
 * Job data for delivery queues
 */
export interface DeliveryJobData {
  event: CanonicalEvent;
  bridgePairId: string;
  targetPlatform: Platform;
  targetChannelId: string;
  targetGuildId: string | null;
  // Webhook info for Discord delivery
  discordWebhookId?: string;
  discordWebhookToken?: string;
  // Whether to sync uploads
  syncUploads: boolean;
}

/**
 * Job data for the ingest queue
 */
export interface IngestJobData {
  event: CanonicalEvent;
}
