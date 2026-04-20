import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  findPlayerByName,
  getReferralLink,
  deleteReferralLink,
  adjustReferrerStatsForLink,
  removePendingReferee,
  rollbackWelcomeBonus,
  rollbackReferrerReward,
  previewWelcomeBonusRollback,
  previewReferrerRewardRollback,
  getCommandPrefix,
  withReferralLocks,
  notifyReferralRollback,
  deleteAdminRepairMarker,
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

  await withReferralLocks(
    gameServerId,
    moduleId,
    [`referee-link:${referee.id}`],
    async () => {
      const link = await getReferralLink(gameServerId, moduleId, referee.id);
      if (!link) {
        throw new TakaroUserError(`Player "${referee.name}" does not have a referral link.`);
      }

      await withReferralLocks(
        gameServerId,
        moduleId,
        [`referrer-quota:${link.referrerId}`],
        async () => {
          if (link.status === 'paying' && !link.rewardGranted) {
            throw new TakaroUserError('This referral payout is still being finalized. Please retry in a moment.');
          }

          const welcomeBonusAmount = Math.max(0, Math.floor(Number(link.welcomeBonusAmount) || 0));
          const rewardRollbackPreview = (link.status === 'paid' || link.rewardGranted)
            ? await previewReferrerRewardRollback(gameServerId, link.referrerId, link)
            : { rolledBack: false, skipped: true, reason: 'not-paid' };

          if (rewardRollbackPreview.reason === 'item-rewards-cannot-be-clawed-back-automatically') {
            throw new TakaroUserError('This paid referral granted item rewards, so it cannot be unlinked automatically. Please compensate players manually instead.');
          }
          if (rewardRollbackPreview.reason === 'insufficient-currency-for-clawback') {
            throw new TakaroUserError('This paid referral cannot be unlinked automatically because the referrer no longer has the full reward amount available for clawback. Please resolve the currency difference manually first.');
          }

          const welcomeBonusPreview = await previewWelcomeBonusRollback(gameServerId, referee.id, welcomeBonusAmount);
          if (!welcomeBonusPreview.canRollback) {
            throw new TakaroUserError('This referral cannot be unlinked automatically because the referee no longer has the full welcome bonus available for clawback. Please resolve the currency difference manually first.');
          }

          const rewardRollback = (link.status === 'paid' || link.rewardGranted)
            ? await rollbackReferrerReward(gameServerId, link.referrerId, link)
            : rewardRollbackPreview;
          const welcomeBonusRolledBack = welcomeBonusAmount > 0
            ? await rollbackWelcomeBonus(gameServerId, referee.id, welcomeBonusAmount)
            : 0;

          await adjustReferrerStatsForLink(gameServerId, moduleId, link.referrerId, link, -1);
          await removePendingReferee(gameServerId, moduleId, referee.id);
          if (link.adminLinked && link.referrerId) {
            await deleteAdminRepairMarker(gameServerId, moduleId, referee.id, link.referrerId);
          }
          await deleteReferralLink(gameServerId, moduleId, referee.id);

          console.log(
            `referral-program: admin unlinked referee=${referee.name}, previousStatus=${link.status}, welcomeBonusRolledBack=${welcomeBonusRolledBack}, referrerRewardRolledBack=${JSON.stringify(rewardRollback)}`,
          );

          await notifyReferralRollback(gameServerId, link.referrerId, referee.id, {
            welcomeBonusRolledBack,
            rewardRollback,
          });

          const statusNote = (link.status === 'paid' || link.rewardGranted)
            ? ` Paid or finalized referral rewards were rolled back${rewardRollback.rolledBack ? '' : ' where possible'}. ${referee.name} and the referrer were notified in-game.`
            : ` Pending referral state was cleared. ${referee.name} and the referrer were notified in-game.`;
          await pog.pm(`Referral link removed for ${referee.name}. Welcome bonus rollback: ${welcomeBonusRolledBack}.${statusNote}`);
        },
        {
          ownerTokenPrefix: 'referral-admin-unlink-referrer',
          busyMessage: 'Another referral update for that player is already in progress. Please try again in a moment.',
        },
      );
    },
    {
      ownerTokenPrefix: 'referral-admin-unlink',
      busyMessage: 'Another referral update for that player is already in progress. Please try again in a moment.',
    },
  );
}

await main();
