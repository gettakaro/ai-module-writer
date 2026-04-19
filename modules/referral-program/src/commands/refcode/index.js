import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { ensureReferralCode } from './referral-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;

  if (!checkPermission(pog, 'REFERRAL_USE')) {
    throw new TakaroUserError('You do not have permission to use referral commands.');
  }

  const code = await ensureReferralCode(gameServerId, mod.moduleId, pog.playerId);
  console.log(`referral-program: generated/refetched code for player=${player.name}, code=${code.code}`);
  await pog.pm(`Your referral code is ${code.code}. Share it with new players so they can use their server command prefix followed by referral ${code.code}.`);
}

await main();
