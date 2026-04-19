import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { ensureReferralCode, getCommandPrefix } from './referral-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;

  if (!checkPermission(pog, 'REFERRAL_USE')) {
    throw new TakaroUserError('You do not have permission to use referral commands.');
  }

  const code = await ensureReferralCode(gameServerId, mod.moduleId, pog.playerId);
  const prefix = await getCommandPrefix(gameServerId);
  console.log(`referral-program: generated/refetched code for player=${player.name}, code=${code.code}, prefix=${prefix}`);
  await pog.pm(`Your referral code is ${code.code}. Tell invited players to type ${prefix}referral ${code.code}.`);
}

await main();
