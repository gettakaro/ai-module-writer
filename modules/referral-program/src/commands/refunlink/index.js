import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  findPlayerByName,
  getReferralLink,
  deleteReferralLink,
  adjustReferrerStatsForLink,
  removePendingReferee,
} from './referral-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const moduleId = mod.moduleId;

  if (!checkPermission(pog, 'REFERRAL_ADMIN')) {
    throw new TakaroUserError('You do not have permission to manage referrals.');
  }

  const refereeName = String(args.referee || '').trim();
  if (!refereeName) {
    throw new TakaroUserError('Usage: /refunlink <referee>');
  }

  const referee = await findPlayerByName(refereeName);
  if (!referee) throw new TakaroUserError(`Referee "${refereeName}" not found.`);

  const link = await getReferralLink(gameServerId, moduleId, referee.id);
  if (!link) {
    throw new TakaroUserError(`Player "${referee.name}" does not have a referral link.`);
  }

  await adjustReferrerStatsForLink(gameServerId, moduleId, link.referrerId, link, -1);

  await removePendingReferee(gameServerId, moduleId, referee.id);
  await deleteReferralLink(gameServerId, moduleId, referee.id);

  console.log(`referral-program: admin unlinked referee=${referee.name}, previousStatus=${link.status}`);
  await pog.pm(`Referral link removed for ${referee.name}.`);
}

await main();
