import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  getReferralCode,
  getReferralLink,
  getReferralStats,
  getPlayerName,
  ensureReferralCode,
  resetDailyCounterIfNeeded,
} from './referral-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;

  if (!checkPermission(pog, 'REFERRAL_USE')) {
    throw new TakaroUserError('You do not have permission to use referral commands.');
  }

  const [codeInfo, link, stats] = await Promise.all([
    getReferralCode(gameServerId, mod.moduleId, pog.playerId),
    getReferralLink(gameServerId, mod.moduleId, pog.playerId),
    getReferralStats(gameServerId, mod.moduleId, pog.playerId),
  ]);

  const ensuredCode = codeInfo ?? await ensureReferralCode(gameServerId, mod.moduleId, pog.playerId);
  const normalizedStats = resetDailyCounterIfNeeded(stats);
  const referrerName = link?.referrerId ? await getPlayerName(link.referrerId) : null;
  const pendingCount = Math.max(0, normalizedStats.referralsTotal - normalizedStats.referralsPaid);

  const lines = [
    `Referral code: ${ensuredCode.code}`,
    `Referrals: total=${normalizedStats.referralsTotal}, paid=${normalizedStats.referralsPaid}, pending=${pendingCount}, today=${normalizedStats.referralsToday}`,
    `Earnings: currency=${normalizedStats.currencyEarned}, items=${normalizedStats.itemsEarned}`,
    `Your referrer: ${referrerName ? referrerName : 'none'}`,
  ];

  console.log(`referral-program: refstats player=${pog.playerId} summary=${lines.join(' | ')}`);
  await pog.pm(lines.join('\n'));
}

await main();
