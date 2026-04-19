import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  findPlayerByName,
  getNormalizedConfig,
  getReferralLink,
  setReferralLink,
  setReferralStats,
  getReferralStats,
  resetDailyCounterIfNeeded,
  awardWelcomeBonus,
  applyPaidReferral,
  getTodayKey,
} from './referral-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const moduleId = mod.moduleId;

  if (!checkPermission(pog, 'REFERRAL_ADMIN')) {
    throw new TakaroUserError('You do not have permission to manage referrals.');
  }

  const refereeName = String(args.referee || '').trim();
  const referrerName = String(args.referrer || '').trim();
  if (!refereeName || !referrerName) {
    throw new TakaroUserError('Usage: /reflink <referee> <referrer>');
  }

  const [referee, referrer] = await Promise.all([
    findPlayerByName(refereeName),
    findPlayerByName(referrerName),
  ]);

  if (!referee) throw new TakaroUserError(`Referee "${refereeName}" not found.`);
  if (!referrer) throw new TakaroUserError(`Referrer "${referrerName}" not found.`);

  const existingLink = await getReferralLink(gameServerId, moduleId, referee.id);
  if (existingLink) {
    throw new TakaroUserError(`Player "${referee.name}" already has a referral link. Use /refunlink first if you need to replace it.`);
  }

  const config = getNormalizedConfig(mod);
  const referrerStatsRaw = await getReferralStats(gameServerId, moduleId, referrer.id);
  const referrerStats = resetDailyCounterIfNeeded(referrerStatsRaw);

  const link = {
    referrerId: referrer.id,
    linkedAt: new Date().toISOString(),
    status: 'pending',
    playtimeAtLink: 0,
    retries: 0,
    adminLinked: true,
  };

  await setReferralLink(gameServerId, moduleId, referee.id, link);
  await awardWelcomeBonus(gameServerId, referee.id, config);
  await setReferralStats(gameServerId, moduleId, referrer.id, {
    ...referrerStats,
    referralsTotal: referrerStats.referralsTotal + 1,
    referralsToday: referrerStats.referralsToday + 1,
    lastReferralDay: getTodayKey(),
  });

  const payout = await applyPaidReferral({
    gameServerId,
    moduleId,
    refereeId: referee.id,
    referrerId: referrer.id,
    link,
    config,
    reason: 'admin-link',
  });

  console.log(`referral-program: admin linked referee=${referee.name} to referrer=${referrer.name}, payout=${JSON.stringify(payout.reward ?? {})}`);
  await pog.pm(`Referral link created: ${referee.name} -> ${referrer.name}. Rewards were paid immediately.`);
}

await main();
