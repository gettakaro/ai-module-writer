import { data, takaro } from '@takaro/helpers';
import {
  getPot,
  setPot,
  getRollover,
  setRollover,
  getDrawNumber,
  setDrawNumber,
  getAllTicketEntries,
  deleteAllTickets,
} from './lottery-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const moduleId = mod.moduleId;
  const config = mod.userConfig;

  const [entries, pot, rollover, drawNumber] = await Promise.all([
    getAllTicketEntries(gameServerId, moduleId),
    getPot(gameServerId, moduleId),
    getRollover(gameServerId, moduleId),
    getDrawNumber(gameServerId, moduleId),
  ]);

  const participantCount = entries.length;
  const totalTickets = entries.reduce((sum, e) => sum + e.tickets, 0);
  const totalPot = pot + rollover;

  console.log(
    `draw-lottery: drawNumber=${drawNumber}, participants=${participantCount}, totalTickets=${totalTickets}, pot=${pot}, rollover=${rollover}, totalPot=${totalPot}`,
  );

  if (participantCount < config.minimumParticipants) {
    console.log(
      `draw-lottery: cancelling draw — only ${participantCount} participant(s), need ${config.minimumParticipants}`,
    );

    if (config.rolloverOnCancel) {
      // Roll over the entire pot to the next draw
      await setRollover(gameServerId, moduleId, totalPot);
      await setPot(gameServerId, moduleId, 0);
      await deleteAllTickets(gameServerId, moduleId);

      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `The lottery draw was cancelled — not enough participants (need ${config.minimumParticipants}, got ${participantCount}). The pot of ${totalPot} rolls over to the next draw! Tickets do not carry over — buy new tickets for the next draw!`,
        opts: {},
      });
    } else {
      // Refund all players; track any failures
      let refundFailures = 0;
      let totalRefunded = 0;
      const failedPlayerIds = [];
      for (const entry of entries) {
        const refund = entry.tickets * config.ticketPrice;
        try {
          await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, entry.playerId, {
            currency: refund,
          });
          totalRefunded += refund;
          console.log(`draw-lottery: refunded ${refund} to player ${entry.playerId}`);
        } catch (refundErr) {
          refundFailures++;
          failedPlayerIds.push(entry.playerId);
          console.error(`draw-lottery: failed to refund player ${entry.playerId} (refund=${refund}). Error: ${refundErr}`);
        }
      }

      // Only delete ticket records for players who were successfully refunded
      if (refundFailures === 0) {
        await setPot(gameServerId, moduleId, 0);
        await setRollover(gameServerId, moduleId, 0);
        await deleteAllTickets(gameServerId, moduleId);

        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `The lottery draw was cancelled — not enough participants (need ${config.minimumParticipants}, got ${participantCount}). All tickets have been refunded.`,
          opts: {},
        });
      } else {
        // Partial refund failure: decrement pot by the amount actually refunded.
        // The remaining pot already includes the rollover amount, so zero rollover to prevent double-counting on next draw.
        const remainingPot = totalPot - totalRefunded;
        await setRollover(gameServerId, moduleId, 0);
        await setPot(gameServerId, moduleId, remainingPot);
        console.error(`draw-lottery: ${refundFailures} refund(s) failed for players: ${failedPlayerIds.join(', ')}. Pot reduced by ${totalRefunded} (refunded amount). Remaining pot: ${remainingPot}. Ticket records preserved for manual recovery.`);

        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `The lottery draw was cancelled — not enough participants. Refunds were partially processed (${entries.length - refundFailures}/${entries.length} succeeded). Please contact an admin if you did not receive your refund.`,
          opts: {},
        });
      }
    }

    return;
  }

  // Weighted random winner selection
  // Walk entries, pick a random number in [0, totalTickets), subtract tickets until we reach zero
  const randomTarget = Math.floor(Math.random() * totalTickets);
  let accumulated = 0;
  let winner = null;

  for (const entry of entries) {
    accumulated += entry.tickets;
    if (randomTarget < accumulated) {
      winner = entry;
      break;
    }
  }

  if (!winner) {
    // Fallback: pick the last entry (shouldn't happen with correct logic)
    winner = entries[entries.length - 1];
    console.error(`draw-lottery: winner selection fallback triggered. randomTarget=${randomTarget}, totalTickets=${totalTickets}`);
  }

  const prize = Math.max(1, Math.floor(totalPot * (1 - config.profitMargin)));
  const newDrawNumber = drawNumber + 1;

  console.log(
    `draw-lottery: winner=${winner.playerId}, tickets=${winner.tickets}/${totalTickets}, prize=${prize}, drawNumber=${newDrawNumber}`,
  );

  // Award the prize; only reset state if award succeeds
  let prizeAwarded = false;
  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, winner.playerId, {
      currency: prize,
    });
    prizeAwarded = true;
  } catch (prizeErr) {
    console.error(`draw-lottery: CRITICAL — failed to award prize to winner ${winner.playerId} (prize=${prize}). State NOT reset to allow manual recovery. Error: ${prizeErr}`);
  }

  if (!prizeAwarded) {
    // Do not reset state — preserve for manual admin recovery
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `LOTTERY ERROR: The draw for Draw #${newDrawNumber} could not be completed — prize award failed. Please contact an admin for manual resolution.`,
      opts: {},
    });
    return;
  }

  // Reset state only after successful prize award
  try {
    await setDrawNumber(gameServerId, moduleId, newDrawNumber);
  } catch (err) {
    console.error(`draw-lottery: failed to setDrawNumber. Error: ${err}`);
  }
  try {
    await setPot(gameServerId, moduleId, 0);
  } catch (err) {
    console.error(`draw-lottery: failed to setPot to 0. Error: ${err}`);
  }
  try {
    await setRollover(gameServerId, moduleId, 0);
  } catch (err) {
    console.error(`draw-lottery: failed to setRollover to 0. Error: ${err}`);
  }
  try {
    await deleteAllTickets(gameServerId, moduleId);
  } catch (err) {
    console.error(`draw-lottery: failed to deleteAllTickets. Error: ${err}`);
  }

  // Look up winner's player name for the broadcast
  let winnerName = 'Unknown Player';
  try {
    const playerResult = await takaro.player.playerControllerGetOne(winner.playerId);
    if (playerResult.data.data && playerResult.data.data.name) {
      winnerName = playerResult.data.data.name;
    }
  } catch (lookupErr) {
    console.error(`draw-lottery: failed to look up winner name for ${winner.playerId}. Using "Unknown Player". Error: ${lookupErr}`);
  }

  // Lead with player name, then prize details
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `*** LOTTERY DRAW *** Congratulations to ${winnerName} for winning ${prize} currency! (Draw #${newDrawNumber} — held ${winner.tickets}/${totalTickets} tickets) See you in the next draw!`,
    opts: {},
  });
}

await main();
