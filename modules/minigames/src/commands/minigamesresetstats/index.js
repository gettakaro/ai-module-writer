import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { resetPlayerStats } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const { target, removedStats } = await resetPlayerStats({ gameServerId, moduleId: mod.moduleId, targetName: args.player });
  await pog.pm(`🧹 ${target.name} stats reset${removedStats ? '.' : ' (no prior stats found).'}`);
}

await main();
