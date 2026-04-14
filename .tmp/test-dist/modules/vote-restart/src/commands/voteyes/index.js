import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getVoteState,
  setVoteState,
  getOnlineNonImmunePlayers,
  computeThreshold,
} from './vote-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  // 1. Check if vote is active and not expired
  const voteState = await getVoteState(gameServerId, moduleId);
  if (!voteState) {
    throw new TakaroUserError('There is no active restart vote. Use /voterestart to start one.');
  }

  if (voteState.status !== 'active') {
    throw new TakaroUserError('The restart vote has already passed. Waiting for restart...');
  }

  const elapsed = (Date.now() - new Date(voteState.startedAt).getTime()) / 1000;
  if (elapsed >= config.voteDuration) {
    throw new TakaroUserError('The restart vote has expired. Use /voterestart to start a new vote.');
  }

  // 2. Check immunity
  if (checkPermission(pog, 'VOTE_RESTART_IMMUNE')) {
    throw new TakaroUserError('You are immune to restart votes and cannot participate in voting.');
  }

  // 3. Check duplicate vote
  if (voteState.voters.includes(pog.playerId)) {
    throw new TakaroUserError('You have already voted yes for this restart.');
  }

  // 4. Add voter
  voteState.voters.push(pog.playerId);
  await setVoteState(gameServerId, moduleId, voteState);

  // 5. Check immediate pass
  const eligiblePlayers = await getOnlineNonImmunePlayers(gameServerId);
  const onlineVoters = voteState.voters.filter((id) =>
    eligiblePlayers.some((p) => p.playerId === id),
  );
  const threshold = computeThreshold(eligiblePlayers.length, config.passThreshold);
  const effectiveVotes = onlineVoters.length;

  console.log(
    `vote-restart: ${player.name} voted yes. effectiveVotes=${effectiveVotes}, threshold=${threshold}, eligible=${eligiblePlayers.length}`,
  );

  if (effectiveVotes >= threshold) {
    voteState.status = 'passed';
    voteState.passedAt = new Date().toISOString();
    await setVoteState(gameServerId, moduleId, voteState);

    console.log(`vote-restart: Vote passed! effectiveVotes=${effectiveVotes}, threshold=${threshold}, status changed to passed`);

    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `[Vote Restart] Vote passed! (${effectiveVotes}/${threshold}) Server will restart in ${config.restartDelay}s.`,
      opts: {},
    });
  } else {
    const remaining = Math.max(0, Math.ceil(config.voteDuration - elapsed));
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `[Vote Restart] ${player.name} voted yes. (${effectiveVotes}/${threshold}, ${remaining}s remaining)`,
      opts: {},
    });
  }
}

await main();
