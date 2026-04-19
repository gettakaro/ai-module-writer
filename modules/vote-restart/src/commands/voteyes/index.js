import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getVoteState,
  getRestartState,
  setVoteState,
  setRestartState,
  getOnlineNonImmunePlayers,
  getRequiredVotes,
  getEffectiveVotes,
  withVoteLock,
} from './vote-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const { threshold, effectiveVotes, elapsed, eligibleCount } = await withVoteLock(gameServerId, moduleId, async () => {
    const voteState = await getVoteState(gameServerId, moduleId);
    if (!voteState) {
      const restartState = await getRestartState(gameServerId, moduleId);
      if (restartState) {
        throw new TakaroUserError('The restart vote has already passed. Waiting for restart...');
      }
      throw new TakaroUserError('There is no active restart vote. Use /voterestart to start one.');
    }

    if (voteState.status !== 'active') {
      throw new TakaroUserError('The restart vote has already passed. Waiting for restart...');
    }

    const elapsed = (Date.now() - new Date(voteState.startedAt).getTime()) / 1000;
    if (elapsed >= config.voteDuration) {
      throw new TakaroUserError('The restart vote has expired. Use /voterestart to start a new vote.');
    }

    if (checkPermission(pog, 'VOTE_RESTART_IMMUNE')) {
      throw new TakaroUserError('You are immune to restart votes and cannot participate in voting.');
    }

    if (voteState.voters.includes(pog.playerId)) {
      throw new TakaroUserError('You have already voted yes for this restart.');
    }

    voteState.voters.push(pog.playerId);
    const eligiblePlayers = await getOnlineNonImmunePlayers(gameServerId);
    const threshold = getRequiredVotes(voteState, eligiblePlayers.length, config.passThreshold);
    const effectiveVotes = getEffectiveVotes(voteState, eligiblePlayers);

    if (effectiveVotes >= threshold) {
      voteState.status = 'passed';
      voteState.passedAt = new Date().toISOString();
      await setVoteState(gameServerId, moduleId, voteState);
      await setRestartState(gameServerId, moduleId, {
        status: 'passed',
        initiatorName: voteState.initiatorName,
        voters: [...voteState.voters],
        passedAt: voteState.passedAt,
        restartAt: new Date(new Date(voteState.passedAt).getTime() + (config.restartDelay * 1000)).toISOString(),
        requiredVotes: threshold,
        eligiblePlayerIds: voteState.eligiblePlayerIds ?? eligiblePlayers.map((p) => p.playerId),
        eligibleCountAtStart: voteState.eligibleCountAtStart ?? eligiblePlayers.length,
      });
    } else {
      await setVoteState(gameServerId, moduleId, voteState);
    }

    return {
      threshold,
      effectiveVotes,
      elapsed,
      eligibleCount: voteState.eligibleCountAtStart ?? eligiblePlayers.length,
    };
  });

  console.log(
    `vote-restart: ${player.name} voted yes. effectiveVotes=${effectiveVotes}, threshold=${threshold}, eligibleSnapshot=${eligibleCount}`,
  );

  if (effectiveVotes >= threshold) {
    console.log(`vote-restart: Vote passed! effectiveVotes=${effectiveVotes}, threshold=${threshold}, status changed to passed`);

    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `[Vote Restart] Vote passed! (${effectiveVotes}/${threshold}) Server will restart in ${config.restartDelay}s. Required votes were locked when the vote started.`,
      opts: {},
    });
  } else {
    const remaining = Math.max(0, Math.ceil(config.voteDuration - elapsed));
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `[Vote Restart] ${player.name} voted yes. (${effectiveVotes}/${threshold}, ${remaining}s remaining, threshold locked at start)`,
      opts: {},
    });
  }
}

await main();
