import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { unbanPlayer } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const { target } = await unbanPlayer({ gameServerId, moduleId: mod.moduleId, targetName: args.player });
  await pog.pm(`✅ ${target.name} can play mini-games again.`);
}

await main();
