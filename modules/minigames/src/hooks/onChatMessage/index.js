import { data } from '@takaro/helpers';
import { getConfig, processReactionMessage } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, eventData } = data;
  const message = eventData?.msg || eventData?.message || '';
  const settled = await processReactionMessage({
    gameServerId,
    moduleId: mod.moduleId,
    player,
    pog,
    config: getConfig(mod),
    message,
  });
  if (settled) {
    console.log(`reactionrace: winner=${player?.name || 'unknown'} message=${message}`);
  }
}

await main();
