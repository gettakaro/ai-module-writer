import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, deleteVariable } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const targetName = String(args.player ?? '').trim();
  if (!targetName) throw new TakaroUserError('Usage: /casinoresetstats <player>');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player \"${targetName}\" not found.`);
  await deleteVariable(gameServerId, mod.moduleId, 'casino_stats', target.playerId);
  await pog.pm(`🧹 Reset casino stats for ${target.player?.name ?? targetName}.`);
}

await main();
