import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, setBan, formatCurrency, formatUtcTimestamp, getDefaultConfig, cancelPlayerCasinoState, removePlayerFromRacePool, refund, sendPlayerMessage, setRecentCancellation, clearBanOverride, getRacePool, KEY_HILO_SESSION, KEY_BLACKJACK_SESSION } from './casino-helpers.js';

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

  const cancelled = await cancelPlayerCasinoState(gameServerId, mod.moduleId, target.playerId, config);
  const racePoolBeforeBan = await getRacePool(gameServerId, mod.moduleId);
  const raceEntriesBeforeBan = (Array.isArray(racePoolBeforeBan?.participants) ? racePoolBeforeBan.participants : [])
    .filter((entry) => entry.playerId === target.playerId);
  const raceRemoval = await removePlayerFromRacePool(gameServerId, mod.moduleId, target.playerId);
  const blockedByDrawing = Array.isArray(raceRemoval) ? false : Boolean(raceRemoval?.blockedByDrawing);
  let removedRaceEntries = Array.isArray(raceRemoval) ? raceRemoval : (raceRemoval?.removedRaceEntries ?? []);
  if (removedRaceEntries.length === 0 && raceEntriesBeforeBan.length > 0 && !blockedByDrawing) {
    removedRaceEntries = raceEntriesBeforeBan;
  }
  const refundedRaceStake = removedRaceEntries.reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  if (refundedRaceStake > 0) {
    await refund({ gameServerId, moduleId: mod.moduleId, playerId: target.playerId, amount: refundedRaceStake, config });
  }
  await clearBanOverride(gameServerId, mod.moduleId, target.playerId);
  await setBan(gameServerId, mod.moduleId, target.playerId, { expiresAt });
  for (const entry of cancelled) {
    if (entry.key === KEY_HILO_SESSION) {
      await setRecentCancellation(gameServerId, mod.moduleId, target.playerId, {
        game: 'hilo',
        amount: Number(entry.amount ?? 0),
        reason: 'ban',
        at: new Date().toISOString(),
      });
    }
    if (entry.key === KEY_BLACKJACK_SESSION) {
      await setRecentCancellation(gameServerId, mod.moduleId, target.playerId, {
        game: 'blackjack',
        amount: Number(entry.amount ?? 0),
        reason: 'ban',
        at: new Date().toISOString(),
      });
    }
  }

  const cleanupBits = [];
  if (cancelled.length > 0) cleanupBits.push(`${cancelled.length} active stake${cancelled.length === 1 ? '' : 's'} refunded`);
  if (removedRaceEntries.length > 0) cleanupBits.push(`${removedRaceEntries.length} race entr${removedRaceEntries.length === 1 ? 'y was' : 'ies were'} removed and ${formatCurrency(refundedRaceStake)} coin refunded`);
  if (blockedByDrawing) cleanupBits.push('race draw was already settling, so any in-flight ticket will be resolved normally without an extra refund');
  const cleanupNote = cleanupBits.length > 0 ? ` Cleanup: ${cleanupBits.join(', ')}.` : '';
  await sendPlayerMessage(pog, `🚫 ${target.player?.name ?? targetName} has been banned from the casino${expiresAt ? ` until ${formatUtcTimestamp(expiresAt)}` : ' permanently'}.${cleanupNote}`);
}

await main();
