import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { getFundCycle, getFundVariable, FUND_LAST_COMPLETION_KEY } from './fund-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;

  if (!checkPermission(pog, 'COMMUNITY_FUND_VIEW_HISTORY')) {
    throw new TakaroUserError('You do not have permission to view fund history.');
  }

  const moduleId = mod.moduleId;

  const [cycleCount, lastCompletionVar] = await Promise.all([
    getFundCycle(gameServerId, moduleId),
    getFundVariable(gameServerId, moduleId, FUND_LAST_COMPLETION_KEY),
  ]);

  console.log(`Fund history: cycleCount=${cycleCount}, hasLastCompletion=${!!lastCompletionVar}`);

  if (cycleCount === 0) {
    await pog.pm('Community Fund: No completions yet. Be the first to help reach the goal! See also: fund, fundstatus');
    return;
  }

  let historyMessage = `Community Fund: ${cycleCount} completion${cycleCount !== 1 ? 's' : ''} total.`;

  if (lastCompletionVar) {
    try {
      const lastCompletion = JSON.parse(lastCompletionVar.value);
      historyMessage += ` Last completion: Round #${lastCompletion.cycle}, ${lastCompletion.completedAt}, by ${lastCompletion.triggerPlayer}.`;
    } catch (err) {
      console.error(`fund-history: failed to parse last completion data. Error: ${err}`);
      historyMessage += ' Last completion details unavailable (history data unavailable).';
    }
  }

  historyMessage += ' See also: fund, fundstatus';

  await pog.pm(historyMessage);
}

await main();
