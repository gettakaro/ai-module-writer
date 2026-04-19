import { data } from '@takaro/helpers';

async function main() {
  const { player } = data;
  console.log(`minigames: player disconnected ${player?.name || 'unknown'}`);
}

await main();
