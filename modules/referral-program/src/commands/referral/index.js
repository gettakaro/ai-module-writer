import { data, TakaroUserError } from '@takaro/helpers';
import {
  ensureReferralCode,
  getNormalizedConfig,
  getPog,
  getPlaytimeMinutes,
  getReferralCodeLookup,
  getReferralLink,
  getReferralStats,
  resetDailyCounterIfNeeded,
  setReferralLink,
  setReferralStats,
  addPendingReferee,
  removePendingReferee,
  deleteReferralLink,
  awardWelcomeBonus,
  rollbackWelcomeBonus,
  getTodayKey,
  getCommandPrefix,
  withReferralLocks,
} from './referral-helpers.js';

function getWelcomeMessage(welcomeBonus, thresholdMinutes) {
  const waitLine = `Your referrer will be paid after you play ${thresholdMinutes} more minute${thresholdMinutes === 1 ? '' : 's'}.`;
  if (welcomeBonus > 0) {
    return `Referral linked successfully. You received ${welcomeBonus} welcome currency. ${waitLine}`;
  }
  return `Referral linked successfully. ${waitLine}`;
}

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const moduleId = mod.moduleId;

  const code = String(args.code || '').trim().toUpperCase();
  if (!code) {
    const prefix = await getCommandPrefix(gameServerId);
    throw new TakaroUserError(`Usage: ${prefix}referral <code>`);
  }

  const lookup = await getReferralCodeLookup(gameServerId, moduleId, code);
  if (!lookup?.playerId) {
    throw new TakaroUserError(`Referral code "${code}" was not found.`);
  }

  if (lookup.playerId === pog.playerId) {
    throw new TakaroUserError('You cannot use your own referral code.');
  }

  const config = getNormalizedConfig(mod);
  const refereePog = await getPog(gameServerId, pog.playerId);
  if (!refereePog) {
    throw new TakaroUserError('Could not load your player record for this server. Please reconnect and try again.');
  }

  const firstSeenMs = new Date(refereePog.createdAt).getTime();
  if (Number.isFinite(firstSeenMs) && config.referralWindowHours >= 0) {
    const ageHours = (Date.now() - firstSeenMs) / (1000 * 60 * 60);
    if (ageHours > config.referralWindowHours) {
      if (config.referralWindowHours === 0) {
        throw new TakaroUserError('Referral claims are disabled on this server right now. Please ask an admin if that seems incorrect.');
      }
      throw new TakaroUserError(`You can only claim a referral within ${config.referralWindowHours} hour${config.referralWindowHours === 1 ? '' : 's'} of first joining this server.`);
    }
  }

  await ensureReferralCode(gameServerId, moduleId, lookup.playerId);

  await withReferralLocks(
    gameServerId,
    moduleId,
    [`referee-link:${pog.playerId}`, `referrer-quota:${lookup.playerId}`],
    async () => {
      const existingLink = await getReferralLink(gameServerId, moduleId, pog.playerId);
      if (existingLink) {
        throw new TakaroUserError('You already have a referral link on this server. An admin can use refunlink if this needs to be corrected.');
      }

      const referrerStatsRaw = await getReferralStats(gameServerId, moduleId, lookup.playerId);
      const referrerStats = resetDailyCounterIfNeeded(referrerStatsRaw);
      if (referrerStats.referralsToday >= config.maxReferralsPerDay) {
        throw new TakaroUserError('That referrer has reached their daily referral limit. Please try again tomorrow or use a different code.');
      }
      if (referrerStats.referralsTotal >= config.maxReferralsLifetime) {
        throw new TakaroUserError('That referrer has reached their lifetime referral limit. Please contact an admin if this needs an override.');
      }

      const baseLink = {
        referrerId: lookup.playerId,
        linkedAt: new Date().toISOString(),
        status: 'linking',
        playtimeAtLink: getPlaytimeMinutes(refereePog),
        retries: 0,
      };

      let welcomeBonus = 0;
      let statsUpdated = false;
      let pendingAdded = false;

      try {
        await setReferralLink(gameServerId, moduleId, pog.playerId, baseLink);

        welcomeBonus = await awardWelcomeBonus(gameServerId, pog.playerId, config);

        const updatedStats = {
          ...referrerStats,
          referralsTotal: referrerStats.referralsTotal + 1,
          referralsToday: referrerStats.referralsToday + 1,
          lastReferralDay: getTodayKey(),
        };
        await setReferralStats(gameServerId, moduleId, lookup.playerId, updatedStats);
        statsUpdated = true;

        await addPendingReferee(gameServerId, moduleId, pog.playerId);
        pendingAdded = true;

        const link = {
          ...baseLink,
          status: 'pending',
          welcomeBonusGranted: welcomeBonus > 0,
          welcomeBonusAmount: welcomeBonus,
        };
        await setReferralLink(gameServerId, moduleId, pog.playerId, link);

        console.log(
          `referral-program: linked referee=${pog.playerId} to referrer=${lookup.playerId}, code=${code}, playtimeAtLink=${link.playtimeAtLink}, welcomeBonus=${welcomeBonus}`,
        );

        await pog.pm(getWelcomeMessage(welcomeBonus, config.playtimeThresholdMinutes));
      } catch (err) {
        if (pendingAdded) {
          await removePendingReferee(gameServerId, moduleId, pog.playerId);
        }

        if (statsUpdated) {
          await setReferralStats(gameServerId, moduleId, lookup.playerId, referrerStats);
        }

        if (welcomeBonus > 0) {
          await rollbackWelcomeBonus(gameServerId, pog.playerId, welcomeBonus);
        }

        await deleteReferralLink(gameServerId, moduleId, pog.playerId);
        throw err;
      }
    },
    {
      ownerTokenPrefix: 'referral-claim',
      busyMessage: 'Another referral claim for this player or code is already being processed. Please try again in a moment.',
    },
  );
}

await main();
