import '../src/lib/env';
import { connectDatabase, disconnectDatabase, prisma } from '../src/lib/database';
import { createChildLogger } from '../src/lib/logger';

const log = createChildLogger('check-bridges');

async function checkBridges() {
  try {
    await connectDatabase();

    const bridges = await prisma.bridgePair.findMany();

    console.log('All bridges:');
    console.log(JSON.stringify(bridges, null, 2));

    await disconnectDatabase();
    process.exit(0);
  } catch (error) {
    log.error({ error }, 'Failed to check bridges');
    process.exit(1);
  }
}

checkBridges();
