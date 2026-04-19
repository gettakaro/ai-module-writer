import { data } from '@takaro/helpers';
import { refreshLeaderboards } from './minigames-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  await refreshLeaderboards(gameServerId, mod.moduleId);
}

await main();
