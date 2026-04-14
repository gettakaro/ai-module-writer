// No permission check — fund status is intentionally public.
import { data } from '@takaro/helpers';
import { getFundTotal, getFundCycle } from './fund-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;

  const moduleId = mod.moduleId;
  const threshold = mod.userConfig.fundThreshold;

  const [currentTotal, cycleCount] = await Promise.all([
    getFundTotal(gameServerId, moduleId),
    getFundCycle(gameServerId, moduleId),
  ]);

  const percent = threshold > 0 ? Math.floor((currentTotal / threshold) * 100) : 0;

  console.log(`Fund status: total=${currentTotal}, threshold=${threshold}, cycle=${cycleCount}, percent=${percent}`);

  await pog.pm(
    `Community Fund: ${currentTotal}/${threshold} (${percent}%) — Round #${cycleCount} (${cycleCount} completion${cycleCount !== 1 ? 's' : ''} total). See also: fund, fundhistory`,
  );
}

await main();
