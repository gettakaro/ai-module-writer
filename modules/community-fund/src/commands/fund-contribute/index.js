import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getFundTotal,
  setFundTotal,
  incrementFundCycle,
  recordCompletion,
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

  // pog.currency is fetched at command dispatch time; the deduct API will also reject if insufficient,
  // so this check is a fast-fail convenience, not a hard guarantee.
  if (pog.currency < amount) {
    const message = `You don't have enough currency. You have ${pog.currency} but tried to contribute ${amount}.`;
    console.log(message);
    throw new TakaroUserError(message);
  }

  // Deduct currency BEFORE updating shared fund state.
  // If the deduction fails due to a race or backend error, the contribution must not advance the
  // fund, cycle, or completion flow.
  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
      currency: amount,
    });
  } catch (deductErr) {
    console.error(`Fund: currency deduction failed for player ${player.name} (amount=${amount}). Contribution aborted. Error: ${deductErr}`);
    throw new TakaroUserError('Your contribution could not be processed because your currency could not be deducted. Please try again.');
  }

  // This read-modify-write is not atomic. If two players contribute simultaneously, both may
  // read the same currentTotal and one contribution could be lost. This is an accepted limitation
  // of the Takaro variable storage platform (no atomic increment API).
  const currentTotal = await getFundTotal(gameServerId, moduleId);
  const newTotal = currentTotal + amount;

  console.log(`Fund contribution: player=${player.name}, amount=${amount}, previousTotal=${currentTotal}, newTotal=${newTotal}, threshold=${threshold}`);

  if (newTotal >= threshold) {
    // Carry overshoot forward instead of discarding excess
    const carryover = newTotal - threshold;

    await setFundTotal(gameServerId, moduleId, carryover);
    const newCycle = await incrementFundCycle(gameServerId, moduleId);
    await recordCompletion(gameServerId, moduleId, newCycle, player.name);

    const completionMsg = config.completionMessage.replace('{threshold}', String(threshold));
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: completionMsg,
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

    await pog.pm(
      `You contributed ${amount} to the community fund. The community fund goal has been met! A new round begins. (Round #${newCycle})`,
    );
  } else {
    await setFundTotal(gameServerId, moduleId, newTotal);

    const percent = Math.floor((newTotal / threshold) * 100);

    await pog.pm(
      `You contributed ${amount} to the community fund. Current total: ${newTotal}/${threshold} (${percent}%).`,
    );

    if (config.broadcastContributions) {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `${player.name} contributed ${amount} to the community fund! Total: ${newTotal}/${threshold} (${percent}%)`,
        opts: {},
      });
    }
  }
}

await main();
