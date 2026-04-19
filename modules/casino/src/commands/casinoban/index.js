import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, setBan, formatCurrency, formatUtcTimestamp, getDefaultConfig, cancelPlayerCasinoState, removePlayerFromRacePool, refund, sendPlayerMessage } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const config = getDefaultConfig(mod.userConfig);
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
  const cancelled = await cancelPlayerCasinoState(gameServerId, mod.moduleId, target.playerId, config);
  const removedRaceEntries = await removePlayerFromRacePool(gameServerId, mod.moduleId, target.playerId);
  const refundedRaceStake = removedRaceEntries.reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  if (refundedRaceStake > 0) {
    await refund({ gameServerId, moduleId: mod.moduleId, playerId: target.playerId, amount: refundedRaceStake, config });
  }
  const cleanupBits = [];
  if (cancelled.length > 0) cleanupBits.push(`${cancelled.length} active stake${cancelled.length === 1 ? '' : 's'} refunded`);
  if (removedRaceEntries.length > 0) cleanupBits.push(`${removedRaceEntries.length} race entr${removedRaceEntries.length === 1 ? 'y was' : 'ies were'} removed and ${formatCurrency(refundedRaceStake)} coin refunded`);
  const cleanupNote = cleanupBits.length > 0 ? ` Cleanup: ${cleanupBits.join(', ')}.` : '';
  await sendPlayerMessage(pog, `🚫 ${target.player?.name ?? targetName} has been banned from the casino${expiresAt ? ` until ${formatUtcTimestamp(expiresAt)}` : ' permanently'}.${cleanupNote}`);
}

await main();
