import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { createChildLogger } from '../lib/logger';
import { prisma } from '../lib/database';
import { checkRateLimit, getRateLimitDelay } from '../lib/rateLimiter';
import { registerOutgoingHash } from '../lib/loopFilter';
import { DiscordClient } from '../platforms/discord/client';
import type { CanonicalAttachment, DeliveryJobData } from '../types/canonical';

const log = createChildLogger('discord-delivery-worker');
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS || '15000',
  10
);
const ATTACHMENT_MAX_BYTES = parseInt(process.env.ATTACHMENT_MAX_BYTES || '26214400', 10); // 25MB

export class DiscordDeliveryWorker {
  private worker: Worker<DeliveryJobData>;
  private discordClient: DiscordClient;

  constructor(discordClient: DiscordClient, channelId: string) {
    this.discordClient = discordClient;

    this.worker = new Worker<DeliveryJobData>(
      `janus_deliver_discord_${channelId}`,
      async (job: Job<DeliveryJobData>) => {
        return this.processJob(job);
      },
      {
        connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
        concurrency: 5,
      }
    );

    this.worker.on('completed', (job) => {
      log.debug({ jobId: job.id }, 'Discord delivery job completed');
    });

    this.worker.on('failed', (job, err) => {
      log.error({ jobId: job?.id, err }, 'Discord delivery job failed');
    });
  }

  async processJob(job: Job<DeliveryJobData>): Promise<void> {
    const {
      event,
      bridgePairId,
      targetChannelId,
      targetGuildId,
      discordWebhookId,
      discordWebhookToken,
      syncUploads,
    } = job.data;

    log.debug(
      { eventType: event.type, messageId: event.source.messageId, targetChannelId },
      'Processing Discord delivery job'
    );

    const allowed = await checkRateLimit('discord', targetChannelId);
    if (!allowed) {
      const delay = await getRateLimitDelay('discord', targetChannelId);
      await job.moveToDelayed(Date.now() + delay);
      log.warn({ targetChannelId, delay }, 'Rate limited, delaying job');
      return;
    }

    if (!discordWebhookId || !discordWebhookToken) {
      log.error({ bridgePairId }, 'Missing webhook credentials');
      return;
    }

    if (event.type === 'MSG_CREATE') {
      await this.handleMessageCreate(
        event,
        targetChannelId,
        targetGuildId,
        discordWebhookId,
        discordWebhookToken,
        bridgePairId,
        syncUploads
      );
    } else if (event.type === 'MSG_UPDATE') {
      await this.handleMessageUpdate(
        event,
        targetChannelId,
        discordWebhookId,
        discordWebhookToken,
        bridgePairId
      );
    } else if (event.type === 'MSG_DELETE') {
      await this.handleMessageDelete(
        event,
        targetChannelId,
        discordWebhookId,
        discordWebhookToken,
        bridgePairId
      );
    }
  }

  private async handleMessageCreate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    targetGuildId: string | null,
    webhookId: string,
    webhookToken: string,
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
    log.debug(
      {
        sourceMsgId: event.source.messageId,
        replyRefId: event.reference?.messageId ?? null,
        replyLinkResolved: !!replyLink,
        attachmentCount: event.attachments.length,
        uploadedFileCount: files.length,
        hasContent: !!content.trim(),
      },
      'Prepared Discord delivery payload'
    );

    if (!content.trim() && files.length === 0) {
      log.debug(
        { messageId: event.source.messageId, hasReference: !!event.reference },
        'Skipping empty Discord delivery message after reply/attachment processing'
      );
      return;
    }

    const destMsgId = await this.discordClient.sendWebhook(
      webhookId,
      webhookToken,
      content,
      event.author.name,
      event.author.avatar,
      files
    );

    if (destMsgId) {
      await prisma.messageMap.create({
        data: {
          pairId: bridgePairId,
          sourcePlatform: event.source.platform,
          sourceMsgId: event.source.messageId,
          destPlatform: 'discord',
          destMsgId,
        },
      });

      await registerOutgoingHash(
        this.buildHashContent(content, event.attachments),
        event.author.name
      );
      log.info({ sourceMsgId: event.source.messageId, destMsgId }, 'Message bridged to Discord');
    }
  }

  private async handleMessageUpdate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    webhookId: string,
    webhookToken: string,
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

    const success = await this.discordClient.editWebhookMessage(
      webhookId,
      webhookToken,
      messageMap.destMsgId,
      event.content
    );

    if (success) {
      log.info(
        { sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId },
        'Message updated on Discord'
      );
    }
  }

  private async handleMessageDelete(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    webhookId: string,
    webhookToken: string,
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

    const success = await this.discordClient.deleteWebhookMessage(
      webhookId,
      webhookToken,
      messageMap.destMsgId
    );

    if (success) {
      await prisma.messageMap.delete({ where: { id: messageMap.id } });
      log.info(
        { sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId },
        'Message deleted on Discord'
      );
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
    log.info('Discord delivery worker closed');
  }

  private async resolveReplyLink(
    bridgePairId: string,
    event: DeliveryJobData['event'],
    targetGuildId: string | null,
    targetChannelId: string
  ): Promise<string | null> {
    const replyToSourceMsgId = event.reference?.messageId;
    if (!replyToSourceMsgId) return null;
    if (!targetGuildId) return null;

    const directMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        sourcePlatform: event.source.platform,
        sourceMsgId: replyToSourceMsgId,
        destPlatform: 'discord',
      },
    });
    if (directMap) {
      return `https://discord.com/channels/${targetGuildId}/${targetChannelId}/${directMap.destMsgId}`;
    }

    const mirroredMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        destPlatform: event.source.platform,
        destMsgId: replyToSourceMsgId,
        sourcePlatform: 'discord',
      },
    });
    if (!mirroredMap) return null;

    return `https://discord.com/channels/${targetGuildId}/${targetChannelId}/${mirroredMap.sourceMsgId}`;
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
          'Failed to download attachment for Discord upload; using URL fallback'
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
}
