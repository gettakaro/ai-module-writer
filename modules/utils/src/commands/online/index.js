import { data, TakaroUserError } from '@takaro/helpers';
import { fetchOnlinePlayers, formatOnlinePlayersLine, safePrivateMessage } from './utils-helpers.js';

async function main() {
  const { gameServerId, pog } = data;
  const onlinePlayers = await fetchOnlinePlayers(gameServerId);
  const message = formatOnlinePlayersLine(onlinePlayers);
  const delivered = await safePrivateMessage(pog, message);
  if (!delivered) {
    throw new TakaroUserError('I could not deliver the online player list right now. Please try again in a moment.');
  }
}

await main();
