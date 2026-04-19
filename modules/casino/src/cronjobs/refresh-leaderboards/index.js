import { data } from '@takaro/helpers';
import { refreshLeaderboardCache } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const cache = await refreshLeaderboardCache(gameServerId, mod.moduleId);
  console.log(`casino.refreshLeaderboards: refreshed at ${cache.refreshedAt}`);
}

await main();
