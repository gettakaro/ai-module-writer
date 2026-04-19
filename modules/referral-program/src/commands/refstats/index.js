import { data } from '@takaro/helpers';
import {
  getReferralCode,
  getReferralLink,
  getReferralStats,
  getPlayerName,
  ensureReferralCode,
  resetDailyCounterIfNeeded,
  getNormalizedConfig,
  getPog,
  getPlaytimeMinutes,
} from './referral-helpers.js';

function formatMinutes(value) {
  return (Math.round(Math.max(0, Number(value) || 0) * 10) / 10).toFixed(1);
}

async function main() {
  const { pog, gameServerId, module: mod } = data;

  const [codeInfo, link, stats, currentPog] = await Promise.all([
    getReferralCode(gameServerId, mod.moduleId, pog.playerId),
    getReferralLink(gameServerId, mod.moduleId, pog.playerId),
    getReferralStats(gameServerId, mod.moduleId, pog.playerId),
    getPog(gameServerId, pog.playerId),
  ]);

  const ensuredCode = codeInfo ?? await ensureReferralCode(gameServerId, mod.moduleId, pog.playerId);
  const normalizedStats = resetDailyCounterIfNeeded(stats);
  const referrerName = link?.referrerId ? await getPlayerName(link.referrerId) : null;
  const pendingCount = Math.max(0, normalizedStats.referralsTotal - normalizedStats.referralsPaid);
  const config = getNormalizedConfig(mod);

  const lines = [
    `Referral code: ${ensuredCode.code}`,
    `Referrals: total=${normalizedStats.referralsTotal}, paid=${normalizedStats.referralsPaid}, pending=${pendingCount}, today=${normalizedStats.referralsToday}`,
    `Earnings: currency=${normalizedStats.currencyEarned}, items=${normalizedStats.itemsEarned}`,
    `Your referrer: ${referrerName ? referrerName : 'none'}`,
  ];

  if (link) {
    lines.push(`Your referral status: ${link.status}`);
    if (link.status === 'pending') {
      const currentPlaytimeMinutes = getPlaytimeMinutes(currentPog);
      const earnedSinceLink = Math.max(0, currentPlaytimeMinutes - (Number(link.playtimeAtLink ?? 0) || 0));
      const remainingMinutes = Math.max(0, config.playtimeThresholdMinutes - earnedSinceLink);
      lines.push(
        `Qualifying progress: ${formatMinutes(earnedSinceLink)}/${formatMinutes(config.playtimeThresholdMinutes)} minutes (${formatMinutes(remainingMinutes)} remaining)`,
      );
    }
    if (link.status === 'rejected' && link.rejectionReason) {
      lines.push(`Last payout error: ${link.rejectionReason}`);
    }
  }

  console.log(`referral-program: refstats player=${pog.playerId} summary=${lines.join(' | ')}`);
  await pog.pm(lines.join('\n'));
}

await main();
