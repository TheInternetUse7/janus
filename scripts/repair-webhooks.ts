import 'dotenv/config';
import { connectDatabase, disconnectDatabase, prisma } from '../src/lib/database';
import { DiscordClient } from '../src/platforms/discord/client';
import { createChildLogger } from '../src/lib/logger';

const log = createChildLogger('repair-webhooks');

async function repairWebhooks() {
  try {
    log.info('Starting webhook repair script...');

    await connectDatabase();
    log.info('Database connected');

    const discordClient = new DiscordClient();
    await discordClient.connect();
    log.info('Discord client connected');

    // Find all bridges with missing webhooks
    const bridges = await prisma.bridgePair.findMany({
      where: {
        OR: [{ discordWebhookId: null }, { discordWebhookToken: null }],
      },
    });

    log.info({ count: bridges.length }, 'Found bridges with missing webhooks');

    for (const bridge of bridges) {
      log.info(
        { bridgeId: bridge.id, discordChannelId: bridge.discordChannelId },
        'Repairing bridge...'
      );

      const webhook = await discordClient.createWebhook(bridge.discordChannelId, 'Janus Bridge');

      if (!webhook) {
        log.error({ bridgeId: bridge.id }, 'Failed to create webhook');
        continue;
      }

      await prisma.bridgePair.update({
        where: { id: bridge.id },
        data: {
          discordWebhookId: webhook.id,
          discordWebhookToken: webhook.token,
        },
      });

      log.info({ bridgeId: bridge.id, webhookId: webhook.id }, 'Bridge repaired successfully');
    }

    log.info('Webhook repair completed');

    discordClient.disconnect();
    await disconnectDatabase();

    process.exit(0);
  } catch (error) {
    log.error({ error }, 'Failed to repair webhooks');
    process.exit(1);
  }
}

repairWebhooks();
