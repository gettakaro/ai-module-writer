import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { banPlayer } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const target = await banPlayer({ gameServerId, moduleId: mod.moduleId, targetName: args.player, hours: args.hours });
  await pog.pm(`🚫 ${target.name} has been banned from mini-games${args.hours ? ` for ${args.hours}h` : ''}.`);
}

await main();
