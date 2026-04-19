import { data } from '@takaro/helpers';
import { getConfig, maybeFireLiveRound } from './minigames-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  await maybeFireLiveRound({
    gameServerId,
    moduleId: mod.moduleId,
    config: getConfig(mod),
  });
}

await main();
