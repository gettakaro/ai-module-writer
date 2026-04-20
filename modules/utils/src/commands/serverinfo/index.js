import { data } from '@takaro/helpers';
import { fetchOnlinePlayers, getGameServerName, safePrivateMessage, trimOrEmpty } from './utils-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod } = data;
  const [serverName, onlinePlayers] = await Promise.all([
    getGameServerName(gameServerId),
    fetchOnlinePlayers(gameServerId),
  ]);

  const lines = [
    `Server: ${serverName}`,
    `Players online: ${onlinePlayers.length}`,
  ];

  const infoMessage = trimOrEmpty(mod.userConfig.serverInfoMessage);
  if (infoMessage !== '') {
    lines.push(`Info: ${infoMessage}`);
  }

  const message = lines.join('\n');
  await safePrivateMessage(pog, message);
}

await main();
