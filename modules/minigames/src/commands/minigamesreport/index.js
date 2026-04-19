import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { buildReport, normalizeOptionalNumberArg } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const days = normalizeOptionalNumberArg(args.days, 7) ?? 7;
  const message = await buildReport(gameServerId, mod.moduleId, Number.isFinite(days) && days > 0 ? days : 7);
  await pog.pm(message);
  console.log(`minigames: report days=${days} summary=${message.replace(/\n/g, ' | ')}`);
}

await main();
