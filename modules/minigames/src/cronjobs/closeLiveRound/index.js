import { data } from '@takaro/helpers';
import { closeExpiredRound } from './minigames-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const closed = await closeExpiredRound({ gameServerId, moduleId: mod.moduleId, reason: 'expired' });
  if (closed) {
    console.log(`minigames: live round closed game=${closed.game} reason=expired`);
  }
}

await main();
