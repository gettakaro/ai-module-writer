import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { closeExpiredRound } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const round = await closeExpiredRound({ gameServerId, moduleId: mod.moduleId, reason: 'skipped' });
  if (!round) {
    await pog.pm('No active round to skip.');
    return;
  }
  await pog.pm(`⏭️ Skipped ${round.game}.`);
}

await main();
