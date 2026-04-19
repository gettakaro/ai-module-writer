import { data } from '@takaro/helpers';
import { getConfig, playHangman } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  await playHangman({
    gameServerId,
    moduleId: mod.moduleId,
    player,
    pog,
    config: getConfig(mod),
    letterOrWord: args.letterOrWord,
  });
}

await main();
