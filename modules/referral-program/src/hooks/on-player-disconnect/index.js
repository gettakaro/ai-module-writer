import { data } from '@takaro/helpers';
import { maybePayReferral } from './referral-helpers.js';

async function main() {
  const { gameServerId, player, module: mod } = data;
  if (!player?.id) {
    console.log('referral-program: disconnect hook received no player id');
    return;
  }

  const result = await maybePayReferral(gameServerId, mod.moduleId, player.id, mod, 'player-disconnected');
  console.log(`referral-program: disconnect hook player=${player.id}, result=${JSON.stringify(result)}`);
}

await main();
