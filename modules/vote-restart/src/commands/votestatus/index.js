import { data } from '@takaro/helpers';
import {
  getVoteState,
  getRestartState,
  getOnlineNonImmunePlayers,
  getRequiredVotes,
  getEffectiveVotes,
} from './vote-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const voteState = await getVoteState(gameServerId, moduleId);
  const restartState = await getRestartState(gameServerId, moduleId);
  const passedState = restartState ?? (voteState?.status === 'passed' ? voteState : null);

  if (!voteState && !passedState) {
    console.log('vote-status: No active restart vote');
    await pog.pm('[Vote Restart] No active restart vote.');
    return;
  }

  if (passedState) {
    const elapsedSincePassed = (Date.now() - new Date(passedState.passedAt).getTime()) / 1000;
    const remainingDelay = Math.ceil(config.restartDelay - elapsedSincePassed);

    if (remainingDelay <= 0) {
      console.log('vote-status: Vote passed; restart already initiated or imminent');
      await pog.pm('[Vote Restart] Vote passed. Server restart is imminent or has already been initiated. If the server has not restarted yet, please contact an admin.');
    } else {
      console.log(`vote-status: Vote passed; server restarting in ${remainingDelay}s`);
      await pog.pm(`[Vote Restart] Vote passed! Server restarting in ${remainingDelay}s. The restart countdown started when the vote passed.`);
    }
    return;
  }

  const elapsed = (Date.now() - new Date(voteState.startedAt).getTime()) / 1000;
  const remaining = Math.max(0, Math.ceil(config.voteDuration - elapsed));

  const eligiblePlayers = await getOnlineNonImmunePlayers(gameServerId);
  const threshold = getRequiredVotes(voteState, eligiblePlayers.length, config.passThreshold);
  const effectiveVotes = getEffectiveVotes(voteState, eligiblePlayers);

  const lockedPool = voteState.eligibleCountAtStart ?? eligiblePlayers.length;
  console.log(`vote-status: active vote ${effectiveVotes}/${threshold}; ${remaining}s remaining; counted players locked at ${lockedPool}`);

  await pog.pm(`[Vote Restart] Restart vote in progress: ${effectiveVotes}/${threshold} votes. ${remaining}s remaining. Only the ${lockedPool} non-immune players who were online when the vote started are counted.`);
}

await main();
