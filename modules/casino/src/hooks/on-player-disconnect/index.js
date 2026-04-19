import { data } from '@takaro/helpers';
import { getDefaultConfig, handleDisconnect } from './casino-helpers.js';

async function main() {
  const { gameServerId, player, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const actions = await handleDisconnect(gameServerId, mod.moduleId, player.id, config);
  console.log(`casino.onPlayerDisconnect: player=${player.name} actions=${actions.length}`);
}

await main();
