import '../src/lib/env';
import { prisma } from '../src/lib/database';
import { FluxerClient } from '../src/platforms/fluxer/client';
import { config } from '../src/config';

async function main() {
  console.log('🔧 Repairing Fluxer webhooks for all bridges...\n');

  // Connect to Fluxer
  const fluxerClient = new FluxerClient();
  await fluxerClient.connect(config.fluxer.token);

  // Wait for client to be ready
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (!fluxerClient.isReady()) {
    console.error('❌ Fluxer client not ready');
    process.exit(1);
  }

  console.log('✅ Fluxer client connected\n');

  // Get all bridges
  const bridges = await prisma.bridgePair.findMany();
  console.log(`Found ${bridges.length} bridge(s)\n`);

  let repairedCount = 0;

  for (const bridge of bridges) {
    console.log(`\nBridge ${bridge.id}:`);
    console.log(`  Discord Channel: ${bridge.discordChannelId}`);
    console.log(`  Fluxer Channel: ${bridge.fluxerChannelId}`);

    if (bridge.fluxerWebhookId && bridge.fluxerWebhookToken) {
      console.log(`  ✅ Already has Fluxer webhook: ${bridge.fluxerWebhookId}`);
      continue;
    }

    console.log(`  ⚠️  Missing Fluxer webhook, creating...`);

    try {
      const webhook = await fluxerClient.createWebhook(bridge.fluxerChannelId, 'Janus Bridge');

      if (!webhook) {
        console.log(`  ❌ Failed to create Fluxer webhook`);
        continue;
      }

      await prisma.bridgePair.update({
        where: { id: bridge.id },
        data: {
          fluxerWebhookId: webhook.id,
          fluxerWebhookToken: webhook.token,
        },
      });

      console.log(`  ✅ Created Fluxer webhook: ${webhook.id}`);
      repairedCount++;
    } catch (error) {
      console.error(`  ❌ Error creating webhook:`, error);
    }
  }

  console.log(`\n✅ Repair complete! Repaired ${repairedCount} bridge(s)`);

  fluxerClient.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
