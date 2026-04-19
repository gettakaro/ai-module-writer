import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, setBan, formatUtcTimestamp } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const targetName = String(args.player ?? '').trim();
  if (!targetName) throw new TakaroUserError('Usage: /casinoban <player> [hours]');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player \"${targetName}\" not found.`);

  const hoursRaw = args.hours;
  let expiresAt = null;
  if (hoursRaw !== undefined && hoursRaw !== null && String(hoursRaw).trim() !== '' && String(hoursRaw) !== '0') {
    const hours = Number(hoursRaw);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new TakaroUserError('Ban duration must be a positive number of hours. Omit it for a permanent ban.');
    }
    expiresAt = new Date(Date.now() + (hours * 60 * 60 * 1000)).toISOString();
  }

  await setBan(gameServerId, mod.moduleId, target.playerId, { expiresAt });
  await pog.pm(`🚫 ${target.player?.name ?? targetName} has been banned from the casino${expiresAt ? ` until ${formatUtcTimestamp(expiresAt)}` : ' permanently'}.`);
}

await main();
