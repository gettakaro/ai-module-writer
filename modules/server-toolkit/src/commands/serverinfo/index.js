import { data } from '@takaro/helpers';
import { trimOrEmpty } from './server-toolkit-pure.js';
import { fetchOnlinePlayers, getGameServerName } from './server-toolkit-helpers.js';

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
  console.log(`toolkit:serverinfo ${message}`);
  await pog.pm(message);
}

await main();
