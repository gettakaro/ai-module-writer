import { data } from '@takaro/helpers';
import { getPendingRefereeIds, maybePayReferral } from './referral-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const moduleId = mod.moduleId;

  const refereeIds = await getPendingRefereeIds(gameServerId, moduleId);
  console.log(`referral-program: sweep starting, pending=${refereeIds.length}`);

  for (const refereeId of refereeIds) {
    const result = await maybePayReferral(gameServerId, moduleId, refereeId, mod, 'cron-sweep');
    console.log(`referral-program: sweep referee=${refereeId}, result=${JSON.stringify(result)}`);
  }
}

await main();
