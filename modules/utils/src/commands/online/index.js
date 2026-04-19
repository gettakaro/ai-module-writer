import { data } from '@takaro/helpers';
import { fetchOnlinePlayers, formatOnlinePlayersLine } from './utils-helpers.js';

async function main() {
  const { gameServerId, pog } = data;
  const onlinePlayers = await fetchOnlinePlayers(gameServerId);
  const message = formatOnlinePlayersLine(onlinePlayers);
  console.log(message);
  await pog.pm(message);
}

await main();
