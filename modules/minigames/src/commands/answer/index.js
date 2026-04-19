import { data } from '@takaro/helpers';
import { getConfig, handleAnswerCommand } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  await handleAnswerCommand({
    gameServerId,
    moduleId: mod.moduleId,
    player,
    pog,
    config: getConfig(mod),
    response: args.response,
  });
}

await main();
