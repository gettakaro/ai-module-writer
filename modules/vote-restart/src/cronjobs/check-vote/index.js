import { data, takaro } from '@takaro/helpers';
import {
  getVoteState,
  getRestartPending,
  setVoteState,
  deleteVoteState,
  setRestartPending,
  deleteRestartPending,
  setCooldownUntil,
  getOnlineNonImmunePlayers,
  computeThreshold,
  acquireExecutionLock,
  releaseExecutionLock,
} from './vote-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const voteState = await getVoteState(gameServerId, moduleId);
  const persistedRestartPending = await getRestartPending(gameServerId, moduleId);
  const restartPending = persistedRestartPending || (voteState?.status === 'passed' ? voteState : null);

  if (!voteState && !restartPending) {
    // No vote in progress — nothing to do
    return;
  }

  console.log(`check-vote: evaluating vote status=${voteState?.status || restartPending?.status || 'none'}`);

  if (voteState?.status === 'active') {
    const elapsed = (Date.now() - new Date(voteState.startedAt).getTime()) / 1000;

    // Check expiry
    if (elapsed >= config.voteDuration) {
      console.log(`check-vote: vote expired after ${Math.floor(elapsed)}s`);

      // Set cooldown
      const cooldownUntil = new Date(Date.now() + config.cooldownDuration * 1000).toISOString();
      await setCooldownUntil(gameServerId, moduleId, cooldownUntil);
      await Promise.all([
        deleteVoteState(gameServerId, moduleId),
        deleteRestartPending(gameServerId, moduleId),
      ]);

      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `[Vote Restart] The restart vote started by ${voteState.initiatorName} has expired. A new vote can be started in ${config.cooldownDuration}s.`,
        opts: {},
      });
      return;
    }

    // Not expired — compute effective votes
    const eligiblePlayers = await getOnlineNonImmunePlayers(gameServerId);
    const onlineVoters = voteState.voters.filter((id) =>
      eligiblePlayers.some((p) => p.playerId === id),
    );
    const threshold = computeThreshold(eligiblePlayers.length, config.passThreshold);
    const effectiveVotes = onlineVoters.length;
    const remaining = Math.max(0, Math.ceil(config.voteDuration - elapsed));

    if (effectiveVotes >= threshold) {
      voteState.status = 'passed';
      voteState.passedAt = new Date().toISOString();
      await Promise.all([
        setVoteState(gameServerId, moduleId, voteState),
        setRestartPending(gameServerId, moduleId, {
          status: 'passed',
          passedAt: voteState.passedAt,
          initiatorName: voteState.initiatorName,
          restartDelay: config.restartDelay,
          restartCommand: config.restartCommand,
        }),
      ]);

      console.log(`check-vote: Vote passed! effectiveVotes=${effectiveVotes}, threshold=${threshold}, status changed to passed`);

      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `[Vote Restart] Vote passed! (${effectiveVotes}/${threshold}) Server will restart in ${config.restartDelay}s.`,
        opts: {},
      });
    }
  } else if (restartPending) {
    const delay = Number(restartPending.restartDelay ?? config.restartDelay) || 0;
    const restartCommand = restartPending.restartCommand || config.restartCommand;
    const elapsedSincePassed = (Date.now() - new Date(restartPending.passedAt).getTime()) / 1000;

    if (restartPending.status === 'executing') {
      console.log('check-vote: restart already issued previously, retrying cleanup only');
      try {
        await deleteRestartPending(gameServerId, moduleId);
      } catch (err) {
        console.error('check-vote: failed to clean up restartPending after previously issued restart', err);
      }
      try {
        await deleteVoteState(gameServerId, moduleId);
      } catch (err) {
        console.error('check-vote: failed to clean up voteState after previously issued restart', err);
      }
      return;
    }

    if (elapsedSincePassed >= delay) {
      const lockToken = await acquireExecutionLock(gameServerId, moduleId, 'restart-execution');
      if (!lockToken) {
        console.log('check-vote: restart execution already claimed by another cron run');
        return;
      }

      try {
        const currentPending = await getRestartPending(gameServerId, moduleId);
        if (!currentPending) {
          console.log('check-vote: restart-pending disappeared before execution');
          return;
        }
        if (currentPending.status === 'executing') {
          console.log('check-vote: restart already issued previously, retrying cleanup only');
          try {
            await deleteRestartPending(gameServerId, moduleId);
          } catch (err) {
            console.error('check-vote: failed to clean up restartPending after concurrently observed executing marker', err);
          }
          try {
            await deleteVoteState(gameServerId, moduleId);
          } catch (err) {
            console.error('check-vote: failed to clean up voteState after concurrently observed executing marker', err);
          }
          return;
        }

        console.log(`check-vote: restart delay elapsed (${Math.floor(elapsedSincePassed)}s), executing restart`);

        await setRestartPending(gameServerId, moduleId, {
          ...currentPending,
          status: 'executing',
          attemptedAt: new Date().toISOString(),
          restartDelay: delay,
          restartCommand,
        });

        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: '[Vote Restart] Restarting now!',
          opts: {},
        });

        try {
          await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
            command: restartCommand,
          });
          console.log('check-vote: restart command executed successfully');
          try {
            await deleteRestartPending(gameServerId, moduleId);
          } catch (err) {
            console.error('check-vote: restart executed but failed to delete restartPending', err);
          }
          try {
            await deleteVoteState(gameServerId, moduleId);
          } catch (err) {
            console.error('check-vote: restart executed but failed to delete voteState', err);
          }
        } catch (cmdErr) {
          console.error(`check-vote: failed to execute restart command "${restartCommand}": ${cmdErr}`);

          const cooldownUntil = new Date(Date.now() + config.cooldownDuration * 1000).toISOString();
          try {
            await setCooldownUntil(gameServerId, moduleId, cooldownUntil);
          } catch (e) {
            console.error('Failed to set cooldown', e);
          }
          try {
            await Promise.all([
              deleteVoteState(gameServerId, moduleId),
              deleteRestartPending(gameServerId, moduleId),
            ]);
          } catch (e) {
            console.error('Failed to delete vote state', e);
          }

          await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
            message: '[Vote Restart] Failed to execute restart command. Please try again later.',
            opts: {},
          });
        }
      } finally {
        await releaseExecutionLock(gameServerId, moduleId, lockToken);
      }
    }
  }
}

await main();
