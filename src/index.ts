import 'dotenv/config';
import { createChildLogger } from './lib/logger';
import { config } from './config';
import { connectDatabase, disconnectDatabase } from './lib/database';
import { disconnectRedis } from './lib/redis';
import { closeAllQueues } from './lib/queues';
import { shutdownBreakers } from './lib/circuitBreaker';
import { DiscordClient } from './platforms/discord/client';
import { FluxerClient } from './platforms/fluxer/client';
import { normalizeToCanonical as normalizeDiscord } from './platforms/discord/normalizer';
import { normalizeToCanonical as normalizeFluxer } from './platforms/fluxer/normalizer';
import { ingestQueue } from './lib/queues';
import { isLoopMessage } from './lib/loopFilter';
import { RouterWorker } from './workers/router';
import { DeliveryWorkerManager } from './lib/deliveryWorkerManager';
import { bridgeService, setDiscordClient, setFluxerClient } from './lib/bridge';

const log = createChildLogger('janus');

class Janus {
  private discordClient: DiscordClient | null = null;
  private fluxerClient: FluxerClient | null = null;
  private routerWorker: RouterWorker | null = null;
  private deliveryWorkerManager: DeliveryWorkerManager | null = null;
  private shuttingDown = false;

  async start(): Promise<void> {
    log.info('Starting Janus bridge...');

    await connectDatabase();
    log.info('Database connected');

    await this.startDiscord();
    await this.startFluxer();

    this.routerWorker = new RouterWorker();
    log.info('Router worker started');

    if (this.discordClient && this.fluxerClient) {
      // Repair any bridges with missing webhook credentials
      await bridgeService.repairAllBridgeWebhooks();

      this.deliveryWorkerManager = new DeliveryWorkerManager(this.discordClient, this.fluxerClient);
      await this.deliveryWorkerManager.loadActiveBridges();
      log.info('Delivery worker manager started');

      bridgeService.on('bridge:created', async (bridge) => {
        if (this.deliveryWorkerManager && bridge.isActive) {
          await this.deliveryWorkerManager.startForBridge(
            bridge.id,
            bridge.discordChannelId,
            bridge.fluxerChannelId
          );
        }
      });

      bridgeService.on('bridge:deleted', async (bridgeId) => {
        if (this.deliveryWorkerManager) {
          await this.deliveryWorkerManager.stopForBridge(bridgeId);
        }
      });

      bridgeService.on('bridge:toggled', async (bridge) => {
        if (this.deliveryWorkerManager) {
          if (bridge.isActive) {
            await this.deliveryWorkerManager.startForBridge(
              bridge.id,
              bridge.discordChannelId,
              bridge.fluxerChannelId
            );
          } else {
            await this.deliveryWorkerManager.stopForBridge(bridge.id);
          }
        }
      });
    }

    log.info({ version: '1.0.0' }, 'Janus bridge started');
  }

  private async startDiscord(): Promise<void> {
    this.discordClient = new DiscordClient();

    setDiscordClient(this.discordClient);

    this.discordClient.on('message', async (event) => {
      const isLoop = await isLoopMessage(event.content, event.author.username);
      if (isLoop) {
        log.debug({ messageId: event.id }, 'Skipping loop message from Discord');
        return;
      }

      const canonical = normalizeDiscord(event, 'MSG_CREATE');
      await ingestQueue.add('ingest', { event: canonical });
      log.debug({ messageId: event.id, channelId: event.channelId }, 'Queued Discord message');
    });

    this.discordClient.on('messageUpdate', async (event) => {
      const canonical = normalizeDiscord(event, 'MSG_UPDATE');
      await ingestQueue.add('ingest', { event: canonical });
      log.debug({ messageId: event.id }, 'Queued Discord message update');
    });

    this.discordClient.on('messageDelete', async (event) => {
      const canonical = normalizeDiscord(
        {
          ...event,
          content: '',
          author: { id: '', username: '', bot: false, avatar: null },
          attachments: [],
          editedAt: null,
          timestamp: new Date().toISOString(),
        },
        'MSG_DELETE'
      );
      await ingestQueue.add('ingest', { event: canonical });
      log.debug({ messageId: event.id }, 'Queued Discord message delete');
    });

    await this.discordClient.connect();
  }

  private async startFluxer(): Promise<void> {
    this.fluxerClient = new FluxerClient();

    setFluxerClient(this.fluxerClient);

    this.fluxerClient.on('message', async (event) => {
      const isLoop = await isLoopMessage(event.content, event.author.name);
      if (isLoop) {
        log.debug({ messageId: event.id }, 'Skipping loop message from Fluxer');
        return;
      }

      const canonical = normalizeFluxer(event, 'MSG_CREATE');
      await ingestQueue.add('ingest', { event: canonical });
      log.debug({ messageId: event.id, channelId: event.channelId }, 'Queued Fluxer message');
    });

    this.fluxerClient.on('messageUpdate', async (event) => {
      const canonical = normalizeFluxer(event, 'MSG_UPDATE');
      await ingestQueue.add('ingest', { event: canonical });
      log.debug({ messageId: event.id }, 'Queued Fluxer message update');
    });

    this.fluxerClient.on('messageDelete', async (event) => {
      const canonical = normalizeFluxer(
        {
          ...event,
          content: '',
          author: { id: '', name: '', avatar: null, bot: false },
          attachments: [],
        },
        'MSG_DELETE'
      );
      await ingestQueue.add('ingest', { event: canonical });
      log.debug({ messageId: (event as any).id }, 'Queued Fluxer message delete');
    });

    await this.fluxerClient.connect(config.fluxer.token);
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    log.info('Shutting down Janus bridge...');

    if (this.discordClient) {
      this.discordClient.disconnect();
    }

    if (this.fluxerClient) {
      this.fluxerClient.disconnect();
    }

    if (this.routerWorker) {
      await this.routerWorker.close();
    }

    if (this.deliveryWorkerManager) {
      await this.deliveryWorkerManager.closeAll();
    }

    await closeAllQueues();
    await disconnectDatabase();
    await disconnectRedis();
    shutdownBreakers();

    log.info('Janus bridge stopped');
  }
}

const janus = new Janus();

process.on('SIGTERM', async () => {
  log.warn('Received SIGTERM, shutting down...');
  await janus.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.warn('Received SIGINT, shutting down...');
  await janus.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  log.error({ err }, 'Uncaught exception');
  process.exit(1);
});

janus.start().catch((err) => {
  log.error({ err }, 'Failed to start Janus');
  process.exit(1);
});
