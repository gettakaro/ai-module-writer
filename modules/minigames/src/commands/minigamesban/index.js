import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { banPlayer, normalizeOptionalNumberArg } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const hours = normalizeOptionalNumberArg(args.hours);
  const target = await banPlayer({ gameServerId, moduleId: mod.moduleId, targetName: args.player, hours });
  await pog.pm(`🚫 ${target.name} has been banned from mini-games${hours ? ` for ${hours}h` : ''}.`);
}

await main();
