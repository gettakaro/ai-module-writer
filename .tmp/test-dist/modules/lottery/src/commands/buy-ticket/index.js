import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getPot,
  setPot,
  getPlayerTickets,
  setPlayerTickets,
} from './lottery-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'LOTTERY_BUY')) {
    throw new TakaroUserError('You do not have permission to buy lottery tickets.');
  }

  const amount = args.amount;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  if (amount === undefined || amount === null) {
    throw new TakaroUserError('Usage: buyticket <amount> — Amount must be a positive whole number.');
  }

  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError('Usage: buyticket <amount> — Amount must be a positive whole number.');
  }

  const ticketPrice = config.ticketPrice;
  const maxTicketsPerPlayer = config.maxTicketsPerPlayer;

  const currentTickets = await getPlayerTickets(gameServerId, moduleId, pog.playerId);

  if (currentTickets + amount > maxTicketsPerPlayer) {
    const remaining = maxTicketsPerPlayer - currentTickets;
    throw new TakaroUserError(
      `You can only hold ${maxTicketsPerPlayer} tickets per draw. You have ${currentTickets} and tried to buy ${amount} more. You can buy ${remaining} more.`,
    );
  }

  // The command cost system auto-deducts 1x ticketPrice before the handler runs.
  // The handler only needs to deduct the ADDITIONAL cost for extra tickets beyond the first.
  const totalCost = amount * ticketPrice;
  const additionalCost = (amount - 1) * ticketPrice;

  // Fast-fail currency check: pog.currency reflects the balance at dispatch time (before command cost auto-deduction).
  // Check total cost against pre-deduction balance to fast-fail.
  if (pog.currency < additionalCost + ticketPrice) {
    throw new TakaroUserError(
      `You don't have enough currency. Buying ${amount} ticket${amount > 1 ? 's' : ''} costs ${totalCost} currency. You have ${pog.currency} currency.`,
    );
  }

  async function deductPlayerCurrency(deductAmount) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
        currency: deductAmount,
      });
      return true;
    } catch (deductErr) {
      console.error(
        `Lottery: currency deduction failed for player ${player.name} (additionalCost=${deductAmount}). Pot and tickets already updated. Error: ${deductErr}`,
      );
      return false;
    }
  }

  // Update state BEFORE deducting currency (player keeps money if state update fails).
  // The pot gets the full amount * ticketPrice because command cost (1x) + additional ((N-1)x) = N*ticketPrice total.
  const newTickets = currentTickets + amount;
  const currentPot = await getPot(gameServerId, moduleId);
  const newPot = currentPot + amount * ticketPrice;

  console.log(
    `Lottery: player=${player.name}, buying ${amount} tickets, currentTickets=${currentTickets}, newTickets=${newTickets}, previousPot=${currentPot}, newPot=${newPot}, totalCost=${totalCost}`,
  );

  await setPlayerTickets(gameServerId, moduleId, pog.playerId, newTickets);
  await setPot(gameServerId, moduleId, newPot);

  // Deduct only the ADDITIONAL cost beyond the 1x auto-deducted by the command cost system.
  let deductionSucceeded = true;
  if (additionalCost > 0) {
    deductionSucceeded = await deductPlayerCurrency(additionalCost);
  }

  const deductionNote = deductionSucceeded ? '' : ' (Note: currency deduction encountered an issue — please contact an admin)';
  await pog.pm(
    `You bought ${amount} ticket${amount > 1 ? 's' : ''} for ${totalCost} currency. You now have ${newTickets} ticket${newTickets > 1 ? 's' : ''} in this draw. Current pot: ${newPot}.${deductionNote}`,
  );

  if (config.announceTicketPurchases) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `${player.name} bought ${amount} lottery ticket${amount > 1 ? 's' : ''}! Current pot: ${newPot}.`,
      opts: {},
    });
  }
}

await main();
