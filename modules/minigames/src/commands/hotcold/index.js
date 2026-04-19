import { data } from '@takaro/helpers';
import { getConfig, playHotCold, normalizeOptionalNumberArg } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  await playHotCold({
    gameServerId,
    moduleId: mod.moduleId,
    player,
    pog,
    config: getConfig(mod),
    number: normalizeOptionalNumberArg(args.number),
  });
}

await main();
