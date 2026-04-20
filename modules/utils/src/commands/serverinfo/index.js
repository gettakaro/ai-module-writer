import { data, TakaroUserError } from '@takaro/helpers';
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
  const delivered = await safePrivateMessage(pog, message);
  if (!delivered) {
    throw new TakaroUserError('I could not deliver the server information message right now. Please try again in a moment.');
  }
}

await main();
