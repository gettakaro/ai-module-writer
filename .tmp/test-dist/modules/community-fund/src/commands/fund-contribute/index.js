import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getFundTotal,
  setFundTotal,
  getFundCycle,
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
    throw new TakaroUserError('Usage: fund <amount> — Amount must be a positive whole number.');
  }

  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError('Usage: fund <amount> — Amount must be a positive whole number.');
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
    throw new TakaroUserError(
      `You don't have enough currency. You have ${pog.currency} but tried to contribute ${amount}.`,
    );
  }

  // Read fund total FIRST, compute new total, update fund THEN deduct currency.
  // This ordering ensures that if the fund update fails, no currency is deducted (player keeps money).
  // If currency deduction fails after the fund update, we log the inconsistency — the fund will be
  // slightly over-counted, which is far preferable to the player losing money without fund credit.
  //
  // This read-modify-write is not atomic. If two players contribute simultaneously, both may
  // read the same currentTotal and one contribution could be lost. This is an accepted limitation
  // of the Takaro variable storage platform (no atomic increment API).
  const currentTotal = await getFundTotal(gameServerId, moduleId);
  const newTotal = currentTotal + amount;

  console.log(`Fund contribution: player=${player.name}, amount=${amount}, previousTotal=${currentTotal}, newTotal=${newTotal}, threshold=${threshold}`);

  // Returns true if deduction succeeded, false if it failed (player keeps their currency).
  async function deductPlayerCurrency(deductAmount) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
        currency: deductAmount,
      });
      return true;
    } catch (deductErr) {
      console.error(`Fund: currency deduction failed for player ${player.name} (amount=${deductAmount}). Fund total was already updated. Error: ${deductErr}`);
      return false;
    }
  }

  if (newTotal >= threshold) {
    // Carry overshoot forward instead of discarding excess
    const carryover = newTotal - threshold;

    // Update fund total BEFORE deducting currency
    await setFundTotal(gameServerId, moduleId, carryover);
    const newCycle = await incrementFundCycle(gameServerId, moduleId);
    await recordCompletion(gameServerId, moduleId, newCycle, player.name);

    const deductionSucceeded = await deductPlayerCurrency(amount);

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

    const deductionNote = deductionSucceeded ? '' : ' (Note: currency deduction encountered an issue — please contact an admin)';
    await pog.pm(
      `You contributed ${amount} to the community fund. The community fund goal has been met! A new round begins. (Round #${newCycle})${deductionNote}`,
    );
  } else {
    // Update fund total BEFORE deducting currency
    await setFundTotal(gameServerId, moduleId, newTotal);

    const deductionSucceeded = await deductPlayerCurrency(amount);

    const percent = Math.floor((newTotal / threshold) * 100);

    const deductionNote = deductionSucceeded ? '' : ' (Note: currency deduction encountered an issue — please contact an admin)';
    await pog.pm(
      `You contributed ${amount} to the community fund. Current total: ${newTotal}/${threshold} (${percent}%).${deductionNote}`,
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
