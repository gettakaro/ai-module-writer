import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, setBan, formatUtcTimestamp } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const targetName = String(args.player ?? '').trim();
  if (!targetName) throw new TakaroUserError('Usage: /casinoban <player> [hours]');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player \"${targetName}\" not found on this game server.`);
  const hours = Number(args.hours ?? 0);
  const expiresAt = hours > 0 ? new Date(Date.now() + (hours * 60 * 60 * 1000)).toISOString() : null;
  await setBan(gameServerId, mod.moduleId, target.playerId, { expiresAt });
  await pog.pm(`🚫 ${target.player?.name ?? targetName} has been banned from the casino${expiresAt ? ` until ${formatUtcTimestamp(expiresAt)}` : ' permanently'}.`);
}

await main();
