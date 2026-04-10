import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { createChildLogger } from '../lib/logger';
import { prisma } from '../lib/database';
import { checkRateLimit, getRateLimitDelay } from '../lib/rateLimiter';
import { registerOutgoingHash } from '../lib/loopFilter';
import { FluxerClient } from '../platforms/fluxer/client';
import type { CanonicalAttachment, DeliveryJobData } from '../types/canonical';

const log = createChildLogger('fluxer-delivery-worker');
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS || '15000',
  10
);
const ATTACHMENT_MAX_BYTES = parseInt(process.env.ATTACHMENT_MAX_BYTES || '26214400', 10); // 25MB

export class FluxerDeliveryWorker {
  private worker: Worker<DeliveryJobData>;
  private fluxerClient: FluxerClient;

  constructor(fluxerClient: FluxerClient, channelId: string) {
    this.fluxerClient = fluxerClient;

    this.worker = new Worker<DeliveryJobData>(
      `janus_deliver_fluxer_${channelId}`,
      async (job: Job<DeliveryJobData>) => {
        return this.processJob(job);
      },
      {
        connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
        concurrency: 5,
      }
    );

    this.worker.on('completed', (job) => {
      log.debug({ jobId: job.id }, 'Fluxer delivery job completed');
    });

    this.worker.on('failed', (job, err) => {
      log.error({ jobId: job?.id, err }, 'Fluxer delivery job failed');
    });
  }

  async processJob(job: Job<DeliveryJobData>): Promise<void> {
    const { event, bridgePairId, targetChannelId, syncUploads } = job.data;

    log.debug(
      { eventType: event.type, messageId: event.source.messageId, targetChannelId },
      'Processing Fluxer delivery job'
    );

    const allowed = await checkRateLimit('fluxer', targetChannelId);
    if (!allowed) {
      const delay = await getRateLimitDelay('fluxer', targetChannelId);
      await job.moveToDelayed(Date.now() + delay);
      log.warn({ targetChannelId, delay }, 'Rate limited, delaying job');
      return;
    }

    // Get bridge pair to access webhook credentials
    const bridge = await prisma.bridgePair.findUnique({
      where: { id: bridgePairId },
    });

    if (!bridge) {
      log.error({ bridgePairId }, 'Bridge pair not found');
      return;
    }

    const fluxerWebhookId = bridge.fluxerWebhookId;
    const fluxerWebhookToken = bridge.fluxerWebhookToken;

    if (event.type === 'MSG_CREATE') {
      await this.handleMessageCreate(
        event,
        targetChannelId,
        bridge.fluxerGuildId,
        fluxerWebhookId,
        fluxerWebhookToken,
        bridgePairId,
        syncUploads
      );
    } else if (event.type === 'MSG_UPDATE') {
      await this.handleMessageUpdate(
        event,
        targetChannelId,
        bridge.fluxerGuildId,
        fluxerWebhookId,
        fluxerWebhookToken,
        bridgePairId
      );
    } else if (event.type === 'MSG_DELETE') {
      await this.handleMessageDelete(
        event,
        targetChannelId,
        fluxerWebhookId,
        fluxerWebhookToken,
        bridgePairId
      );
    }
  }

  private async handleMessageCreate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    targetGuildId: string | null,
    fluxerWebhookId: string | null,
    fluxerWebhookToken: string | null,
    bridgePairId: string,
    syncUploads: boolean
  ): Promise<void> {
    let content = event.content ?? '';
    const files: Array<{ name: string; data: Buffer }> = [];
    const attachmentsForLinks: CanonicalAttachment[] = [];

    if (event.attachments.length > 0) {
      if (syncUploads) {
        const { downloadedFiles, failedAttachments } = await this.downloadAttachments(
          event.attachments
        );
        files.push(...downloadedFiles);
        attachmentsForLinks.push(...failedAttachments);
      } else {
        attachmentsForLinks.push(...event.attachments);
      }
    }

    if (attachmentsForLinks.length > 0) {
      content = this.appendAttachmentLinks(content, attachmentsForLinks);
    }

    const replyLink = await this.resolveReplyLink(
      bridgePairId,
      event,
      targetGuildId,
      targetChannelId
    );
    content = this.appendReplyFooter(content, replyLink);
    if (!content.trim() && files.length === 0) {
      log.debug(
        { messageId: event.source.messageId, hasReference: !!event.reference },
        'Skipping empty Fluxer delivery message after reply/attachment processing'
      );
      return;
    }

    log.debug(
      {
        sourceMsgId: event.source.messageId,
        replyRefId: event.reference?.messageId ?? null,
        replyLinkResolved: !!replyLink,
        attachmentCount: event.attachments.length,
        uploadedFileCount: files.length,
        hasContent: !!content.trim(),
      },
      'Prepared Fluxer delivery payload'
    );

    // Use webhook if available, otherwise fall back to regular message
    if (fluxerWebhookId && fluxerWebhookToken) {
      // Send via webhook and capture the message ID
      const destMsgId = await this.fluxerClient.sendWebhook(
        fluxerWebhookId,
        fluxerWebhookToken,
        content,
        event.author.name,
        event.author.avatar,
        targetChannelId, // Pass channelId to enable message ID capture
        files
      );

      if (destMsgId) {
        // Create message mapping for edit/delete sync
        await prisma.messageMap.create({
          data: {
            pairId: bridgePairId,
            sourcePlatform: event.source.platform,
            sourceMsgId: event.source.messageId,
            destPlatform: 'fluxer',
            destMsgId,
          },
        });
      }

      if (destMsgId) {
        // Register the outgoing hash for loop detection
        await registerOutgoingHash(
          this.buildHashContent(content, event.attachments),
          event.author.name
        );
        log.info({ sourceMsgId: event.source.messageId, destMsgId }, 'Message bridged to Fluxer');
        return;
      }

      throw new Error(`Failed to deliver message to Fluxer for source ${event.source.messageId}`);
    } else {
      log.warn(
        { bridgePairId },
        'Missing Fluxer webhook credentials, falling back to regular message'
      );
      const result = await this.fluxerClient.sendMessage(targetChannelId, {
        content,
        masquerade: {
          name: event.author.name,
          avatar: event.author.avatar || '',
        },
        files,
      });

      const destMsgId = result?.id || null;

      if (destMsgId) {
        await prisma.messageMap.create({
          data: {
            pairId: bridgePairId,
            sourcePlatform: event.source.platform,
            sourceMsgId: event.source.messageId,
            destPlatform: 'fluxer',
            destMsgId,
          },
        });

        await registerOutgoingHash(
          this.buildHashContent(content, event.attachments),
          event.author.name
        );
        log.info({ sourceMsgId: event.source.messageId, destMsgId }, 'Message bridged to Fluxer');
        return;
      }

      throw new Error(`Failed to deliver message to Fluxer for source ${event.source.messageId}`);
    }
  }

  private async handleMessageUpdate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    targetGuildId: string | null,
    fluxerWebhookId: string | null,
    fluxerWebhookToken: string | null,
    bridgePairId: string
  ): Promise<void> {
    const messageMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        sourcePlatform: event.source.platform,
        sourceMsgId: event.source.messageId,
      },
    });

    if (!messageMap) {
      log.debug({ sourceMsgId: event.source.messageId }, 'No message map found for update');
      return;
    }

    // Fluxer doesn't support editing webhook messages via API.
    // Workaround: post a new edited message, delete the old mirrored message, and repoint mapping.
    // If the source message is itself a reply, preserve the reply footer consistently.
    if (fluxerWebhookId && fluxerWebhookToken) {
      const replyLink = await this.resolveReplyLink(
        bridgePairId,
        event,
        targetGuildId,
        targetChannelId
      );
      const updateContent = this.appendReplyFooter(event.content ?? '', replyLink);
      const previousDestMsgId = messageMap.destMsgId;

      const updateMsgId = await this.fluxerClient.sendWebhook(
        fluxerWebhookId,
        fluxerWebhookToken,
        updateContent,
        event.author.name,
        event.author.avatar,
        targetChannelId
      );

      if (updateMsgId) {
        try {
          if (previousDestMsgId !== updateMsgId) {
            await this.fluxerClient.deleteMessage(previousDestMsgId, targetChannelId);
          }
        } catch (error) {
          log.warn(
            { sourceMsgId: event.source.messageId, previousDestMsgId, updateMsgId, error },
            'Failed to delete previous mirrored Fluxer message during edit replacement'
          );
        }
        await prisma.messageMap.update({
          where: { id: messageMap.id },
          data: { destMsgId: updateMsgId },
        });
      } else {
        throw new Error(`Failed to update message on Fluxer for source ${event.source.messageId}`);
      }

      await registerOutgoingHash(updateContent, event.author.name);
      log.info(
        {
          sourceMsgId: event.source.messageId,
          previousDestMsgId: messageMap.destMsgId,
          updateDestMsgId: updateMsgId,
        },
        'Message update mirrored on Fluxer (replace-by-send workaround)'
      );
    } else {
      await this.fluxerClient.editMessage(messageMap.destMsgId, targetChannelId, event.content);
      log.info(
        { sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId },
        'Message updated on Fluxer'
      );
    }
  }

  private buildFluxerMessageUrl(
    guildId: string | null,
    channelId: string,
    messageId: string
  ): string {
    const guildSegment = guildId ?? '@me';
    const baseUrl = process.env.FLUXER_WEB_BASE_URL?.replace(/\/+$/, '') || 'https://fluxer.app';
    return `${baseUrl}/channels/${guildSegment}/${channelId}/${messageId}`;
  }

  private async handleMessageDelete(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    _fluxerWebhookId: string | null,
    _fluxerWebhookToken: string | null,
    bridgePairId: string
  ): Promise<void> {
    const messageMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        sourcePlatform: event.source.platform,
        sourceMsgId: event.source.messageId,
      },
    });

    if (!messageMap) {
      log.debug({ sourceMsgId: event.source.messageId }, 'No message map found for deletion');
      return;
    }

    // Bot can delete any message in the channel with Manage Messages permission
    await this.fluxerClient.deleteMessage(messageMap.destMsgId, targetChannelId);
    await prisma.messageMap.delete({ where: { id: messageMap.id } });
    log.info(
      { sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId },
      'Message deleted on Fluxer'
    );
  }

  private async resolveReplyLink(
    bridgePairId: string,
    event: DeliveryJobData['event'],
    targetGuildId: string | null,
    targetChannelId: string
  ): Promise<string | null> {
    // TODO: Reply links are resolved at mirror time only.
    // If the referenced mirrored message is later replaced/deleted (e.g. Discord edit/delete mirrored to Fluxer),
    // existing reply footers will point to a dead link until that reply message itself is mirrored again.
    // A full fix needs reverse-reference tracking so downstream replies can be rewritten proactively.
    const replyToSourceMsgId = event.reference?.messageId;
    if (!replyToSourceMsgId) return null;

    const directMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        sourcePlatform: event.source.platform,
        sourceMsgId: replyToSourceMsgId,
        destPlatform: 'fluxer',
      },
    });
    if (directMap) {
      return this.buildFluxerMessageUrl(targetGuildId, targetChannelId, directMap.destMsgId);
    }

    const mirroredMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        destPlatform: event.source.platform,
        destMsgId: replyToSourceMsgId,
        sourcePlatform: 'fluxer',
      },
    });
    if (!mirroredMap) return null;

    return this.buildFluxerMessageUrl(targetGuildId, targetChannelId, mirroredMap.sourceMsgId);
  }

  private appendReplyFooter(content: string, replyLink: string | null): string {
    if (!replyLink) return content;

    const footer = `-# Reply to: [message link](${replyLink})`;
    return content ? `${content}\n${footer}` : footer;
  }

  private appendAttachmentLinks(content: string, attachments: CanonicalAttachment[]): string {
    if (attachments.length === 0) return content;

    const lines = attachments
      .map((att) => `-# [Attachment: ${att.filename}](${att.url})`)
      .join('\n');
    return content ? `${content}\n${lines}` : lines;
  }

  private async downloadAttachments(attachments: CanonicalAttachment[]): Promise<{
    downloadedFiles: Array<{ name: string; data: Buffer }>;
    failedAttachments: CanonicalAttachment[];
  }> {
    const downloadedFiles: Array<{ name: string; data: Buffer }> = [];
    const failedAttachments: CanonicalAttachment[] = [];

    for (const [index, attachment] of attachments.entries()) {
      try {
        const response = await axios.get<ArrayBuffer>(attachment.url, {
          responseType: 'arraybuffer',
          timeout: ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
          maxContentLength: ATTACHMENT_MAX_BYTES,
          maxBodyLength: ATTACHMENT_MAX_BYTES,
          validateStatus: (status) => status >= 200 && status < 300,
        });
        const fallbackName = `attachment-${index + 1}`;
        downloadedFiles.push({
          name: attachment.filename || fallbackName,
          data: Buffer.from(response.data),
        });
      } catch (error) {
        failedAttachments.push(attachment);
        log.warn(
          { attachmentUrl: attachment.url, attachmentName: attachment.filename, error },
          'Failed to download attachment for Fluxer upload; using URL fallback'
        );
      }
    }

    return { downloadedFiles, failedAttachments };
  }

  private buildHashContent(content: string, attachments: CanonicalAttachment[]): string {
    const attachmentUrls = attachments.map((att) => att.url).join('\n');
    const combined = [content, attachmentUrls].filter(Boolean).join('\n');
    return combined || content;
  }

  async close(): Promise<void> {
    await this.worker.close();
    log.info('Fluxer delivery worker closed');
  }
}
