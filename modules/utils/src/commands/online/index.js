import { data } from '@takaro/helpers';
import { fetchOnlinePlayers } from './utils-helpers.js';
import { formatOnlinePlayersLine } from './utils-formatters.js';

async function main() {
  const { gameServerId, pog } = data;
  const onlinePlayers = await fetchOnlinePlayers(gameServerId);
  const message = formatOnlinePlayersLine(onlinePlayers);
  console.log(message);
  await pog.pm(message);
}

await main();
