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
  rollbackWelcomeBonus,
  applyPaidReferral,
  addPendingReferee,
  removePendingReferee,
  deleteReferralLink,
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
  if (referee.id === referrer.id) {
    throw new TakaroUserError('Referee and referrer must be different players.');
  }

  const existingLink = await getReferralLink(gameServerId, moduleId, referee.id);
  if (existingLink) {
    throw new TakaroUserError(`Player "${referee.name}" already has a referral link. Use /refunlink first if you need to replace it.`);
  }

  const config = getNormalizedConfig(mod);
  const referrerStatsRaw = await getReferralStats(gameServerId, moduleId, referrer.id);
  const referrerStats = resetDailyCounterIfNeeded(referrerStatsRaw);

  const baseLink = {
    referrerId: referrer.id,
    linkedAt: new Date().toISOString(),
    status: 'linking',
    playtimeAtLink: 0,
    retries: 0,
    adminLinked: true,
  };

  let welcomeBonus = 0;
  let statsUpdated = false;
  let pendingAdded = false;

  try {
    await setReferralLink(gameServerId, moduleId, referee.id, baseLink);

    welcomeBonus = await awardWelcomeBonus(gameServerId, referee.id, config);

    await setReferralStats(gameServerId, moduleId, referrer.id, {
      ...referrerStats,
      referralsTotal: referrerStats.referralsTotal + 1,
      referralsToday: referrerStats.referralsToday + 1,
      lastReferralDay: getTodayKey(),
    });
    statsUpdated = true;

    await addPendingReferee(gameServerId, moduleId, referee.id);
    pendingAdded = true;

    const pendingLink = {
      ...baseLink,
      status: 'pending',
      welcomeBonusGranted: welcomeBonus > 0,
      welcomeBonusAmount: welcomeBonus,
    };
    await setReferralLink(gameServerId, moduleId, referee.id, pendingLink);

    const payout = await applyPaidReferral({
      gameServerId,
      moduleId,
      refereeId: referee.id,
      referrerId: referrer.id,
      link: pendingLink,
      config,
      reason: 'admin-link',
    });

    if (payout.paid) {
      console.log(`referral-program: admin linked referee=${referee.name} to referrer=${referrer.name}, payout=${JSON.stringify(payout.reward ?? {})}`);
      await pog.pm(`Referral link created: ${referee.name} -> ${referrer.name}. Rewards were paid immediately.`);
      return;
    }

    console.warn(`referral-program: admin link created for referee=${referee.name}, referrer=${referrer.name}, payout deferred=${payout.reason}`);
    await pog.pm(`Referral link created: ${referee.name} -> ${referrer.name}. Immediate payout was deferred (${payout.reason}); the sweep job will retry it.`);
  } catch (err) {
    if (pendingAdded) {
      await removePendingReferee(gameServerId, moduleId, referee.id);
    }
    if (statsUpdated) {
      await setReferralStats(gameServerId, moduleId, referrer.id, referrerStats);
    }
    if (welcomeBonus > 0) {
      await rollbackWelcomeBonus(gameServerId, referee.id, welcomeBonus);
    }
    await deleteReferralLink(gameServerId, moduleId, referee.id);
    throw err;
  }
}

await main();
