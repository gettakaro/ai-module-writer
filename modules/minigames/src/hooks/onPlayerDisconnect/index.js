import { data } from '@takaro/helpers';

async function main() {
  const { player, eventData, gameServerId } = data;
  const playerName = player?.name || eventData?.player?.name || eventData?.name || 'unknown';
  const playerId = player?.id || eventData?.playerId || eventData?.player?.id || 'unknown';
  console.log(`minigames: disconnect hook handled player-disconnected name=${playerName} playerId=${playerId} gameServerId=${gameServerId}`);
  console.log(`minigames: disconnect payload=${JSON.stringify(eventData || {})}`);
}

await main();
