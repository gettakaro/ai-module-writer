import { data } from '@takaro/helpers';
import { fetchOnlinePlayers, formatOnlinePlayersLine, safePrivateMessage } from './utils-helpers.js';

async function main() {
  const { gameServerId, pog } = data;
  const onlinePlayers = await fetchOnlinePlayers(gameServerId);
  const message = formatOnlinePlayersLine(onlinePlayers);
  await safePrivateMessage(pog, message);
}

await main();
