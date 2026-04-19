import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  acquireFundStateLock,
  FUND_STATE_LOCK_KEY,
  FUND_TOTAL_KEY,
  FUND_CYCLE_KEY,
  FUND_LAST_COMPLETION_KEY,
  getFundCycle,
  getFundTotal,
  getFundVariable,
  setFundTotal,
  setFundVariable,
  incrementFundCycle,
  recordCompletion,
  assertFundStateLock,
  consumeFundDebugFlag,
  FUND_DEBUG_FORCE_STATE_WRITE_FAILURE_KEY,
  FUND_DEBUG_FORCE_REFUND_FAILURE_KEY,
  FUND_DEBUG_REPLACE_LOCK_OWNER_KEY,
  releaseFundStateLock,
} from './fund-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'COMMUNITY_FUND_CONTRIBUTE')) {
    throw new TakaroUserError('You do not have permission to contribute to the community fund.');
  }

  const amount = args.amount;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  if (amount === undefined || amount === null) {
    throw new TakaroUserError('Usage: /fund <amount> — Amount must be a positive whole number.');
  }

  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError('Usage: /fund <amount> — Amount must be a positive whole number.');
  }

  if (amount < config.minimumContribution) {
    throw new TakaroUserError(
      `Minimum contribution is ${config.minimumContribution}. You tried to contribute ${amount}.`,
    );
  }

  const threshold = config.fundThreshold;
  if (!threshold || threshold <= 0) {
    throw new TakaroUserError('The community fund is not currently configured. Please contact an admin.');
  }

  const lockOwner = `${player.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try {
    await acquireFundStateLock(gameServerId, moduleId, lockOwner);
  } catch (lockErr) {
    console.error(`Fund: failed to acquire contribution lock for player ${player.name}. Error: ${lockErr}`);
    throw new TakaroUserError('The community fund is busy processing another contribution. Please try again in a moment.');
  }

  let currentTotal;
  let currentCycle;
  let previousTotalVariable;
  let previousCycleVariable;
  let previousCompletionVariable;
  let newTotal;
  let newCycle;
  let thresholdReached = false;

  try {
    // pog.currency is fetched at command dispatch time; the deduct API will also reject if insufficient,
    // so this check is a fast-fail convenience, not a hard guarantee.
    if (pog.currency < amount) {
      const message = `You don't have enough currency. You have ${pog.currency} but tried to contribute ${amount}.`;
      console.log(message);
      throw new TakaroUserError(message);
    }

    // The fund state lock serializes contributions so each paid deposit sees the latest total.
    try {
      await assertFundStateLock(gameServerId, moduleId, lockOwner);
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
        currency: amount,
      });
      await assertFundStateLock(gameServerId, moduleId, lockOwner);
    } catch (deductErr) {
      console.error(`Fund: currency deduction failed for player ${player.name} (amount=${amount}). Contribution aborted. Error: ${deductErr}`);
      throw new TakaroUserError('Your contribution could not be processed because your currency could not be deducted. Please try again.');
    }

    try {
      if (await consumeFundDebugFlag(gameServerId, moduleId, FUND_DEBUG_FORCE_STATE_WRITE_FAILURE_KEY)) {
        throw new Error('Debug-forced contribution state failure after deduct');
      }

      await assertFundStateLock(gameServerId, moduleId, lockOwner);
      previousTotalVariable = await getFundVariable(gameServerId, moduleId, FUND_TOTAL_KEY);
      previousCycleVariable = await getFundVariable(gameServerId, moduleId, FUND_CYCLE_KEY);
      previousCompletionVariable = await getFundVariable(gameServerId, moduleId, FUND_LAST_COMPLETION_KEY);
      currentTotal = await getFundTotal(gameServerId, moduleId);
      currentCycle = await getFundCycle(gameServerId, moduleId);
      newTotal = currentTotal + amount;

      console.log(`Fund contribution: player=${player.name}, amount=${amount}, previousTotal=${currentTotal}, newTotal=${newTotal}, threshold=${threshold}`);

      if (newTotal >= threshold) {
        thresholdReached = true;
        const carryover = newTotal - threshold;
        await setFundTotal(gameServerId, moduleId, carryover);
        await assertFundStateLock(gameServerId, moduleId, lockOwner);
        newCycle = await incrementFundCycle(gameServerId, moduleId);
        await assertFundStateLock(gameServerId, moduleId, lockOwner);
        await recordCompletion(gameServerId, moduleId, newCycle, player.name);
      } else {
        await setFundTotal(gameServerId, moduleId, newTotal);
      }
    } catch (stateErr) {
      console.error(`Fund: failed to persist contribution state for player ${player.name} after deducting ${amount}. Attempting currency rollback. Error: ${stateErr}`);
      let refunded = false;
      try {
        if (await consumeFundDebugFlag(gameServerId, moduleId, FUND_DEBUG_FORCE_REFUND_FAILURE_KEY)) {
          throw new Error('Debug-forced refund failure after contribution-state failure');
        }

        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
          currency: amount,
        });
        refunded = true;
        console.log(`Fund: rolled back ${amount} currency to player ${player.name} after contribution-state failure.`);
      } catch (rollbackErr) {
        console.error(`Fund: CRITICAL rollback failure for player ${player.name} after contribution-state failure. Manual intervention required. Rollback error: ${rollbackErr}`);
      }

      if (refunded) {
        try {
          await assertFundStateLock(gameServerId, moduleId, lockOwner);
          if (previousTotalVariable) {
            await setFundVariable(gameServerId, moduleId, FUND_TOTAL_KEY, JSON.parse(previousTotalVariable.value));
          } else {
            const currentTotalVariable = await getFundVariable(gameServerId, moduleId, FUND_TOTAL_KEY);
            if (currentTotalVariable) {
              await takaro.variable.variableControllerDelete(currentTotalVariable.id);
            }
          }

          if (previousCycleVariable) {
            await setFundVariable(gameServerId, moduleId, FUND_CYCLE_KEY, JSON.parse(previousCycleVariable.value));
          } else {
            const currentCycleVariable = await getFundVariable(gameServerId, moduleId, FUND_CYCLE_KEY);
            if (currentCycleVariable) {
              await takaro.variable.variableControllerDelete(currentCycleVariable.id);
            }
          }

          if (previousCompletionVariable) {
            await setFundVariable(gameServerId, moduleId, FUND_LAST_COMPLETION_KEY, JSON.parse(previousCompletionVariable.value));
          } else {
            const currentCompletionVariable = await getFundVariable(gameServerId, moduleId, FUND_LAST_COMPLETION_KEY);
            if (currentCompletionVariable) {
              await takaro.variable.variableControllerDelete(currentCompletionVariable.id);
            }
          }
        } catch (restoreErr) {
          console.error(`Fund: failed to restore shared state after refunding player ${player.name}. Manual inspection recommended. Error: ${restoreErr}`);
        }

        throw new TakaroUserError('Your contribution could not be recorded, so your currency was refunded. Please try again.');
      }

      throw new TakaroUserError('Your contribution could not be recorded, and we could not confirm your refund. Please contact an admin immediately.');
    }

    if (await consumeFundDebugFlag(gameServerId, moduleId, FUND_DEBUG_REPLACE_LOCK_OWNER_KEY)) {
      await setFundVariable(gameServerId, moduleId, FUND_STATE_LOCK_KEY, {
        owner: `${lockOwner}:other-owner`,
        createdAt: Date.now(),
        refreshedAt: Date.now(),
      });
    }
  } finally {
    try {
      const released = await releaseFundStateLock(gameServerId, moduleId, lockOwner);
      if (!released) {
        console.warn(`Fund: contribution lock for player ${player.name} was not released because ownership changed or the lock was already cleared.`);
      }
    } catch (releaseErr) {
      console.error(`Fund: failed to release contribution lock for player ${player.name}. Error: ${releaseErr}`);
    }
  }

  if (thresholdReached) {
    const completionMsg = config.completionMessage.replace('{threshold}', String(threshold));
    const carryover = newTotal - threshold;
    const nextRound = newCycle + 1;
    const carryoverMessage = carryover > 0
      ? ` ${carryover} currency carried over into Round #${nextRound}.`
      : ` Round #${nextRound} is now active.`;
    const completionBroadcast = `${completionMsg} Completed round #${newCycle}; starting Round #${nextRound}.${carryover > 0 ? ` ${carryover} currency carried over.` : ''}`;
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: completionBroadcast,
      opts: {},
    });

    // Fire-and-forget: completion commands are best-effort. Failures are logged to Takaro's
    // execution logs but do not interrupt the player's contribution flow or block the fund reset.
    // Admins can review logs if a command silently failed.
    const completionCommands = config.completionCommands || [];
    for (const cmd of completionCommands) {
      try {
        await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command: cmd });
      } catch (cmdErr) {
        console.error(`Fund completion: failed to execute completion command "${cmd}". Error: ${cmdErr}`);
      }
    }

    const playerMessage = `You contributed ${amount} to the community fund. The community fund goal has been met! Completed round #${newCycle}; now starting Round #${nextRound}.${carryoverMessage}`;

    console.log(playerMessage);
    await pog.pm(playerMessage);
  } else {
    const percent = Math.floor((newTotal / threshold) * 100);
    const playerMessage = `You contributed ${amount} to the community fund. Current total: ${newTotal}/${threshold} (${percent}%).`;

    console.log(playerMessage);
    await pog.pm(playerMessage);

    if (config.broadcastContributions) {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `${player.name} contributed ${amount} to the community fund! Total: ${newTotal}/${threshold} (${percent}%)`,
        opts: {},
      });
    }
  }
}

await main();
