import { data } from '@takaro/helpers';
import {
  getVoteState,
  getOnlineNonImmunePlayers,
  computeThreshold,
} from './vote-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const voteState = await getVoteState(gameServerId, moduleId);

  if (!voteState) {
    console.log('vote-status: No active restart vote');
    await pog.pm('[Vote Restart] No active restart vote.');
    return;
  }

  if (voteState.status === 'passed') {
    const elapsedSincePassed = (Date.now() - new Date(voteState.passedAt).getTime()) / 1000;
    const remainingDelay = Math.ceil(config.restartDelay - elapsedSincePassed);

    if (remainingDelay <= 0) {
      console.log('vote-status: passed, restart already initiated');
      await pog.pm('[Vote Restart] Server restart is imminent or has already been initiated. If the server hasn\'t restarted, please contact an admin.');
    } else {
      console.log(`vote-status: passed, restarting in ${remainingDelay}s`);
      await pog.pm(`[Vote Restart] Vote passed! Server restarting in ${remainingDelay}s.`);
    }
    return;
  }

  // Active vote
  const elapsed = (Date.now() - new Date(voteState.startedAt).getTime()) / 1000;
  const remaining = Math.max(0, Math.ceil(config.voteDuration - elapsed));

  const eligiblePlayers = await getOnlineNonImmunePlayers(gameServerId);
  const onlineVoters = voteState.voters.filter((id) =>
    eligiblePlayers.some((p) => p.playerId === id),
  );
  const threshold = computeThreshold(eligiblePlayers.length, config.passThreshold);
  const effectiveVotes = onlineVoters.length;

  console.log(`vote-status: active, effectiveVotes=${effectiveVotes}/${threshold}, ${remaining}s remaining`);

  await pog.pm(`[Vote Restart] Restart vote in progress: ${effectiveVotes}/${threshold} votes. ${remaining}s remaining.`);
}

await main();
