import { data } from '@takaro/helpers';
import { formatOnlinePlayersLine } from './server-toolkit-pure.js';
import { fetchOnlinePlayers } from './server-toolkit-helpers.js';

async function main() {
  const { gameServerId, pog } = data;
  const onlinePlayers = await fetchOnlinePlayers(gameServerId);
  const message = formatOnlinePlayersLine(onlinePlayers);
  console.log(`toolkit:online ${message}`);
  await pog.pm(message);
}

await main();
