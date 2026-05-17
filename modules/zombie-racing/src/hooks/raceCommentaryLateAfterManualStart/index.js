import { data } from '@takaro/helpers';
import { broadcastRaceCommentary } from './utils.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const { skipped } = await broadcastRaceCommentary(gameServerId, mod.moduleId, mod.userConfig, 'manual', 'late');
  if (skipped) return;
  console.log('racing:commentary hook=raceCommentaryLateAfterManualStart stage=late');
}

await main();
