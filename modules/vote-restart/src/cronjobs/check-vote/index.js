import { data, takaro } from '@takaro/helpers';
import {
  getVoteState,
  getRestartState,
  setVoteState,
  setRestartState,
  deleteVoteState,
  deleteRestartState,
  setCooldownUntil,
  getOnlineNonImmunePlayers,
  getRequiredVotes,
  getEffectiveVotes,
  withVoteLock,
} from './vote-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const outcome = await withVoteLock(gameServerId, moduleId, async () => {
    const voteState = await getVoteState(gameServerId, moduleId);
    const restartState = await getRestartState(gameServerId, moduleId);
    if (!voteState && !restartState) {
      return { type: 'none' };
    }

    console.log(`check-vote: evaluating vote status=${voteState?.status ?? restartState?.status ?? 'none'}`);

    if (voteState?.status === 'active') {
      const elapsed = (Date.now() - new Date(voteState.startedAt).getTime()) / 1000;

      if (elapsed >= config.voteDuration) {
        console.log(`check-vote: vote expired after ${Math.floor(elapsed)}s`);
        const cooldownUntil = new Date(Date.now() + config.cooldownDuration * 1000).toISOString();
        await setCooldownUntil(gameServerId, moduleId, cooldownUntil);
        await deleteVoteState(gameServerId, moduleId);
        await deleteRestartState(gameServerId, moduleId);
        return { type: 'expired', initiatorName: voteState.initiatorName };
      }

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
        console.log(`check-vote: Vote passed! effectiveVotes=${effectiveVotes}, threshold=${threshold}, status changed to passed`);
        return { type: 'passed', effectiveVotes, threshold };
      }
      return { type: 'active' };
    }

    const passedState = restartState ?? voteState;
    if (!passedState?.passedAt) {
      return { type: 'none' };
    }

    const elapsedSincePassed = (Date.now() - new Date(passedState.passedAt).getTime()) / 1000;
    if (elapsedSincePassed < config.restartDelay) {
      return { type: 'waiting' };
    }

    return { type: 'restart-now' };
  });

  if (outcome.type === 'none' || outcome.type === 'active' || outcome.type === 'waiting') {
    return;
  }

  if (outcome.type === 'expired') {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `[Vote Restart] The restart vote started by ${outcome.initiatorName} has expired. A new vote can be started in ${config.cooldownDuration}s.`,
      opts: {},
    });
    console.log(`check-vote: expired notice sent for ${outcome.initiatorName}`);
    return;
  }

  if (outcome.type === 'passed') {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `[Vote Restart] Vote passed! (${outcome.effectiveVotes}/${outcome.threshold}) Server will restart in ${config.restartDelay}s. Only the non-immune players who were online when the vote started were counted.`,
      opts: {},
    });
    return;
  }

  console.log('check-vote: restart delay elapsed, clearing vote state before executing restart');

  await withVoteLock(gameServerId, moduleId, async () => {
    await deleteVoteState(gameServerId, moduleId);
    await deleteRestartState(gameServerId, moduleId);
  });

  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: '[Vote Restart] Restarting now!',
    opts: {},
  });

  try {
    await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
      command: config.restartCommand,
    });
    console.log('check-vote: restart command executed successfully');
  } catch (cmdErr) {
    const failureMessage = `check-vote: failed to execute restart command "${config.restartCommand}": ${cmdErr}`;
    console.error(failureMessage);
    console.log(failureMessage);
    const cooldownUntil = new Date(Date.now() + config.cooldownDuration * 1000).toISOString();
    await withVoteLock(gameServerId, moduleId, async () => {
      await setCooldownUntil(gameServerId, moduleId, cooldownUntil);
      await deleteVoteState(gameServerId, moduleId);
      await deleteRestartState(gameServerId, moduleId);
    });

    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: '[Vote Restart] Failed to execute restart command. Please try again later.',
      opts: {},
    });
    console.log('[Vote Restart] Failed to execute restart command. Please try again later.');
  }
}

await main();
