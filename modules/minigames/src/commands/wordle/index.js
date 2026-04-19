import { data } from '@takaro/helpers';
import { getConfig, playWordle } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  await playWordle({
    gameServerId,
    moduleId: mod.moduleId,
    player,
    pog,
    config: getConfig(mod),
    guess: args.guess,
  });
}

await main();
