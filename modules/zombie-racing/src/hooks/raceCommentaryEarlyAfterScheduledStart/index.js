import { data } from '@takaro/helpers';
import { broadcastRaceCommentary } from './utils.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const { skipped } = await broadcastRaceCommentary(gameServerId, mod.moduleId, mod.userConfig, 'scheduled', 'early');
  if (skipped) return;
  console.log('racing:commentary hook=raceCommentaryEarlyAfterScheduledStart stage=early');
}

await main();
