import { data } from '@takaro/helpers';
import { closeExpiredRound } from './minigames-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  await closeExpiredRound({ gameServerId, moduleId: mod.moduleId, reason: 'expired' });
}

await main();
