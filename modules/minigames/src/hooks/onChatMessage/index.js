import { data, takaro } from '@takaro/helpers';
import { getConfig, processReactionMessage, getPlayerOnGameServer } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, eventData } = data;
  const message = eventData?.msg || eventData?.message || '';
  let effectivePlayer = player;
  let effectivePog = pog;

  if (!effectivePlayer && eventData?.playerId) {
    try {
      const playerRes = await takaro.player.playerControllerGetOne(eventData.playerId);
      effectivePlayer = playerRes.data.data || null;
    } catch (err) {
      console.log(`reactionrace: failed to resolve player ${eventData.playerId} from hook payload. Error: ${err}`);
    }
  }

  if (!effectivePog && effectivePlayer?.id) {
    effectivePog = await getPlayerOnGameServer(gameServerId, effectivePlayer.id);
  }

  console.log(`reactionrace: hook message=${message} player=${effectivePlayer?.id || player?.id || 'none'} pog=${effectivePog?.id || 'none'} eventKeys=${Object.keys(eventData || {}).join(',')}`);

  const settled = await processReactionMessage({
    gameServerId,
    moduleId: mod.moduleId,
    player: effectivePlayer,
    pog: effectivePog,
    config: getConfig(mod),
    message,
  });
  if (settled) {
    console.log(`reactionrace: winner=${player?.name || 'unknown'} message=${message}`);
  }
}

await main();
