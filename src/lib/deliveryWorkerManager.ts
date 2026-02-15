import { Worker } from 'bullmq';
import { createChildLogger } from './logger';
import { prisma } from './database';
import { DiscordClient } from '../platforms/discord/client';
import { FluxerClient } from '../platforms/fluxer/client';
import type { DeliveryJobData } from '../types/canonical';
import { DiscordDeliveryWorker } from '../workers/discord-delivery';
import { FluxerDeliveryWorker } from '../workers/fluxer-delivery';

const log = createChildLogger('delivery-worker-manager');

interface WorkerSet {
  discord?: DiscordDeliveryWorker;
  fluxer?: FluxerDeliveryWorker;
}

export class DeliveryWorkerManager {
  private workers = new Map<string, WorkerSet>();
  private discordClient: DiscordClient;
  private fluxerClient: FluxerClient;

  constructor(discordClient: DiscordClient, fluxerClient: FluxerClient) {
    this.discordClient = discordClient;
    this.fluxerClient = fluxerClient;
  }

  async startForBridge(bridgeId: string, discordChannelId: string, fluxerChannelId: string): Promise<void> {
    if (this.workers.has(bridgeId)) {
      log.debug({ bridgeId }, 'Workers already exist for bridge');
      return;
    }

    const workerSet: WorkerSet = {};

    if (discordChannelId) {
      workerSet.discord = new DiscordDeliveryWorker(this.discordClient, discordChannelId);
      log.info({ bridgeId, channelId: discordChannelId }, 'Started Discord delivery worker');
    }

    if (fluxerChannelId) {
      workerSet.fluxer = new FluxerDeliveryWorker(this.fluxerClient, fluxerChannelId);
      log.info({ bridgeId, channelId: fluxerChannelId }, 'Started Fluxer delivery worker');
    }

    this.workers.set(bridgeId, workerSet);
  }

  async stopForBridge(bridgeId: string): Promise<void> {
    const workerSet = this.workers.get(bridgeId);
    if (!workerSet) {
      log.debug({ bridgeId }, 'No workers found for bridge');
      return;
    }

    if (workerSet.discord) {
      await workerSet.discord.close();
      log.info({ bridgeId }, 'Stopped Discord delivery worker');
    }

    if (workerSet.fluxer) {
      await workerSet.fluxer.close();
      log.info({ bridgeId }, 'Stopped Fluxer delivery worker');
    }

    this.workers.delete(bridgeId);
  }

  async loadActiveBridges(): Promise<void> {
    log.info('Loading active bridges...');
    
    const bridges = await prisma.bridgePair.findMany({
      where: { isActive: true },
    });

    log.info({ count: bridges.length }, 'Found active bridges');

    for (const bridge of bridges) {
      await this.startForBridge(
        bridge.id,
        bridge.discordChannelId,
        bridge.fluxerChannelId
      );
    }

    log.info('Finished loading bridges');
  }

  async closeAll(): Promise<void> {
    log.info('Closing all delivery workers...');
    
    for (const [bridgeId] of this.workers) {
      await this.stopForBridge(bridgeId);
    }

    log.info('All delivery workers closed');
  }
}
