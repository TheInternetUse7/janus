import { EventEmitter } from 'events';
import { prisma } from './database';
import { createChildLogger } from './logger';
import { BridgePair } from '@prisma/client';
import { DiscordClient } from '../platforms/discord/client';
import { FluxerClient } from '../platforms/fluxer/client';

const log = createChildLogger('bridge-service');

let discordClient: DiscordClient | null = null;
let fluxerClient: FluxerClient | null = null;

export function setDiscordClient(client: DiscordClient): void {
  discordClient = client;
}

export function setFluxerClient(client: FluxerClient): void {
  fluxerClient = client;
}

export interface BridgeEvents {
  'bridge:created': (bridge: BridgePair) => void;
  'bridge:deleted': (bridgeId: string) => void;
  'bridge:toggled': (bridge: BridgePair) => void;
}

export class BridgeService extends EventEmitter {
  async createBridge(
    discordChannelId: string,
    fluxerChannelId: string,
    discordGuildId: string,
    fluxerGuildId?: string
  ): Promise<BridgePair> {
    try {
      let discordWebhookId: string | null = null;
      let discordWebhookToken: string | null = null;
      let fluxerWebhookId: string | null = null;
      let fluxerWebhookToken: string | null = null;

      // Create Discord webhook
      if (discordClient) {
        const webhook = await discordClient.createWebhook(discordChannelId, 'Janus Bridge');
        if (webhook) {
          discordWebhookId = webhook.id;
          discordWebhookToken = webhook.token;
          log.info(
            { discordChannelId, webhookId: discordWebhookId },
            'Created Discord webhook for bridge'
          );
        }
      }

      // Create Fluxer webhook
      if (fluxerClient) {
        const webhook = await fluxerClient.createWebhook(fluxerChannelId, 'Janus Bridge');
        if (webhook) {
          fluxerWebhookId = webhook.id;
          fluxerWebhookToken = webhook.token;
          log.info(
            { fluxerChannelId, webhookId: fluxerWebhookId },
            'Created Fluxer webhook for bridge'
          );
        }
      }

      const bridge = await prisma.bridgePair.create({
        data: {
          discordChannelId,
          fluxerChannelId,
          discordGuildId,
          fluxerGuildId: fluxerGuildId || null,
          discordWebhookId,
          discordWebhookToken,
          fluxerWebhookId,
          fluxerWebhookToken,
        },
      });
      log.info({ bridgeId: bridge.id }, 'Bridge created');
      this.emit('bridge:created', bridge);
      return bridge;
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new Error('Bridge validation failed: Bridge pair already exists');
      }
      log.error({ discordChannelId, fluxerChannelId, error }, 'Failed to create bridge');
      throw error;
    }
  }

  async listBridges(discordGuildId?: string, fluxerGuildId?: string): Promise<BridgePair[]> {
    try {
      const where: any = {};
      if (discordGuildId) where.discordGuildId = discordGuildId;
      if (fluxerGuildId) where.fluxerGuildId = fluxerGuildId;

      return await prisma.bridgePair.findMany({ where });
    } catch (error) {
      log.error({ discordGuildId, fluxerGuildId, error }, 'Failed to list bridges');
      throw error;
    }
  }

  async deleteBridge(bridgeId: string): Promise<BridgePair> {
    try {
      const bridge = await prisma.bridgePair.delete({
        where: { id: bridgeId },
      });
      log.info({ bridgeId }, 'Bridge deleted');
      this.emit('bridge:deleted', bridgeId);
      return bridge;
    } catch (error) {
      log.error({ bridgeId, error }, 'Failed to delete bridge');
      throw error;
    }
  }

  async toggleBridge(bridgeId: string, active: boolean): Promise<BridgePair> {
    try {
      const bridge = await prisma.bridgePair.update({
        where: { id: bridgeId },
        data: { isActive: active },
      });
      log.info({ bridgeId, active }, 'Bridge toggled');
      this.emit('bridge:toggled', bridge);
      return bridge;
    } catch (error) {
      log.error({ bridgeId, active, error }, 'Failed to toggle bridge');
      throw error;
    }
  }

  async getBridgeByChannel(
    platform: 'discord' | 'fluxer',
    channelId: string
  ): Promise<BridgePair | null> {
    try {
      const where =
        platform === 'discord' ? { discordChannelId: channelId } : { fluxerChannelId: channelId };

      return await prisma.bridgePair.findFirst({ where });
    } catch (error) {
      log.error({ platform, channelId, error }, 'Failed to get bridge by channel');
      throw error;
    }
  }

  async repairBridgeWebhook(bridgeId: string): Promise<BridgePair | null> {
    try {
      const bridge = await prisma.bridgePair.findUnique({
        where: { id: bridgeId },
      });

      if (!bridge) {
        log.error({ bridgeId }, 'Bridge not found');
        return null;
      }

      const needsDiscordWebhook = !bridge.discordWebhookId || !bridge.discordWebhookToken;
      const needsFluxerWebhook = !bridge.fluxerWebhookId || !bridge.fluxerWebhookToken;

      if (!needsDiscordWebhook && !needsFluxerWebhook) {
        log.debug({ bridgeId }, 'Bridge already has all webhook credentials');
        return bridge;
      }

      const updateData: any = {};

      // Repair Discord webhook if needed
      if (needsDiscordWebhook) {
        if (!discordClient) {
          log.error({ bridgeId }, 'Discord client not available for webhook repair');
        } else {
          const webhook = await discordClient.createWebhook(
            bridge.discordChannelId,
            'Janus Bridge'
          );
          if (webhook) {
            updateData.discordWebhookId = webhook.id;
            updateData.discordWebhookToken = webhook.token;
            log.info({ bridgeId, webhookId: webhook.id }, 'Repaired Discord webhook');
          } else {
            log.error(
              { bridgeId, discordChannelId: bridge.discordChannelId },
              'Failed to create Discord webhook for bridge repair'
            );
          }
        }
      }

      // Repair Fluxer webhook if needed
      if (needsFluxerWebhook) {
        if (!fluxerClient) {
          log.error({ bridgeId }, 'Fluxer client not available for webhook repair');
        } else {
          const webhook = await fluxerClient.createWebhook(bridge.fluxerChannelId, 'Janus Bridge');
          if (webhook) {
            updateData.fluxerWebhookId = webhook.id;
            updateData.fluxerWebhookToken = webhook.token;
            log.info({ bridgeId, webhookId: webhook.id }, 'Repaired Fluxer webhook');
          } else {
            log.error(
              { bridgeId, fluxerChannelId: bridge.fluxerChannelId },
              'Failed to create Fluxer webhook for bridge repair'
            );
          }
        }
      }

      // Only update if we have changes
      if (Object.keys(updateData).length === 0) {
        log.warn({ bridgeId }, 'No webhooks could be repaired');
        return bridge;
      }

      const updatedBridge = await prisma.bridgePair.update({
        where: { id: bridgeId },
        data: updateData,
      });

      return updatedBridge;
    } catch (error) {
      log.error({ bridgeId, error }, 'Failed to repair bridge webhook');
      throw error;
    }
  }

  async repairAllBridgeWebhooks(): Promise<void> {
    try {
      const bridges = await prisma.bridgePair.findMany({
        where: {
          OR: [{ discordWebhookId: null }, { discordWebhookToken: null }],
        },
      });

      if (bridges.length === 0) {
        log.debug('No bridges need webhook repair');
        return;
      }

      log.info({ count: bridges.length }, 'Repairing bridges with missing webhooks');

      for (const bridge of bridges) {
        await this.repairBridgeWebhook(bridge.id);
      }

      log.info('Finished repairing bridge webhooks');
    } catch (error) {
      log.error({ error }, 'Failed to repair all bridge webhooks');
      throw error;
    }
  }
}

export const bridgeService = new BridgeService();
