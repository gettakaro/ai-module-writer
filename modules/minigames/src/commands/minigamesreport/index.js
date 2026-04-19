import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { buildReport } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const days = Number(args.days || 7);
  await pog.pm(await buildReport(gameServerId, mod.moduleId, Number.isFinite(days) && days > 0 ? days : 7));
}

await main();
