import { data } from '@takaro/helpers';
import { getDefaultConfig, handleDisconnect } from './casino-helpers.js';

async function main() {
  const { gameServerId, player, eventData, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const playerId = player?.id ?? eventData?.playerId ?? eventData?.player?.id;
  const playerName = player?.name ?? eventData?.playerName ?? eventData?.player?.name ?? playerId;
  if (!playerId) {
    console.log('casino.onPlayerDisconnect: no playerId on disconnect event');
    return;
  }
  const actions = await handleDisconnect(gameServerId, mod.moduleId, playerId, config);
  console.log(`casino.onPlayerDisconnect: player=${playerName} actions=${actions.length}`);
}

await main();
