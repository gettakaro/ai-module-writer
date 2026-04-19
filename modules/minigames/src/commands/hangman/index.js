import { data } from '@takaro/helpers';
import { getConfig, playHangman, normalizeOptionalStringArg } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  await playHangman({
    gameServerId,
    moduleId: mod.moduleId,
    player,
    pog,
    config: getConfig(mod),
    letterOrWord: normalizeOptionalStringArg(args.letterOrWord),
  });
}

await main();
