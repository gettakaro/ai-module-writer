import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  findPlayerByName,
  getReferralLink,
  deleteReferralLink,
  adjustReferrerStatsForLink,
  removePendingReferee,
  rollbackWelcomeBonus,
  rollbackReferrerReward,
  getCommandPrefix,
} from './referral-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const moduleId = mod.moduleId;

  if (!checkPermission(pog, 'REFERRAL_ADMIN')) {
    throw new TakaroUserError('You do not have permission to manage referrals.');
  }

  const refereeName = String(args.referee || '').trim();
  if (!refereeName) {
    const prefix = await getCommandPrefix(gameServerId);
    throw new TakaroUserError(`Usage: ${prefix}refunlink <referee>`);
  }

  const referee = await findPlayerByName(gameServerId, refereeName);
  if (!referee) throw new TakaroUserError(`Referee "${refereeName}" was not found on this server.`);

  const link = await getReferralLink(gameServerId, moduleId, referee.id);
  if (!link) {
    throw new TakaroUserError(`Player "${referee.name}" does not have a referral link.`);
  }

  if (link.status === 'paying') {
    throw new TakaroUserError('This referral payout is still being finalized. Please retry in a moment.');
  }

  const welcomeBonusAmount = Math.max(0, Math.floor(Number(link.welcomeBonusAmount) || 0));
  let rewardRollback = { rolledBack: false, skipped: true, reason: 'not-paid' };

  if (link.status === 'paid') {
    rewardRollback = await rollbackReferrerReward(gameServerId, link.referrerId, link);
    if (rewardRollback.reason === 'item-rewards-cannot-be-clawed-back-automatically') {
      throw new TakaroUserError('This paid referral granted item rewards, so it cannot be unlinked automatically. Please compensate players manually instead.');
    }
  }

  let welcomeBonusRolledBack = 0;
  if (welcomeBonusAmount > 0) {
    welcomeBonusRolledBack = await rollbackWelcomeBonus(gameServerId, referee.id, welcomeBonusAmount);
  }

  await adjustReferrerStatsForLink(gameServerId, moduleId, link.referrerId, link, -1);
  await removePendingReferee(gameServerId, moduleId, referee.id);
  await deleteReferralLink(gameServerId, moduleId, referee.id);

  console.log(
    `referral-program: admin unlinked referee=${referee.name}, previousStatus=${link.status}, welcomeBonusRolledBack=${welcomeBonusRolledBack}, referrerRewardRolledBack=${JSON.stringify(rewardRollback)}`,
  );

  const statusNote = link.status === 'paid'
    ? ` Paid referral rewards were rolled back${rewardRollback.rolledBack ? '' : ' where possible'}.`
    : ' Pending referral state was cleared.';
  await pog.pm(`Referral link removed for ${referee.name}. Welcome bonus rollback: ${welcomeBonusRolledBack}.${statusNote}`);
}

await main();
