import { data, takaro } from '@takaro/helpers';
import { getDefaultConfig, getRacePool, setRacePool, withCasinoLocks, pickWeightedWinner, settle, refund, formatCurrency, getBan } from './casino-helpers.js';

function emptyPool() {
  return {
    participants: [],
    drawAt: null,
    status: 'open',
  };
}

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);

  const snapshot = await withCasinoLocks(gameServerId, mod.moduleId, ['race-pool'], async () => {
    const pool = await getRacePool(gameServerId, mod.moduleId);
    const participants = Array.isArray(pool.participants) ? [...pool.participants] : [];
    const due = pool.drawAt && new Date(pool.drawAt).getTime() <= Date.now();
    const isRetry = pool.status === 'drawing' && participants.length > 0;

    if ((!due && !isRetry) || participants.length === 0) {
      return null;
    }

    if (!isRetry) {
      await setRacePool(gameServerId, mod.moduleId, {
        ...pool,
        participants,
        status: 'drawing',
      });
    }

    return {
      participants,
    };
  });

  if (!snapshot) {
    console.log('casino.drawRace: nothing to draw');
    return;
  }

  try {
    const bannedPlayerIds = new Set();
    for (const participant of snapshot.participants) {
      const ban = await getBan(gameServerId, mod.moduleId, participant.playerId);
      if (ban) bannedPlayerIds.add(participant.playerId);
    }

    const refundedParticipants = snapshot.participants.filter((participant) => bannedPlayerIds.has(participant.playerId));
    const activeParticipants = snapshot.participants.filter((participant) => !bannedPlayerIds.has(participant.playerId));
    const cancelled = activeParticipants.length < 2;
    const totalPot = activeParticipants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
    const winner = cancelled ? null : pickWeightedWinner(activeParticipants);
    const payout = cancelled ? 0 : Math.round(totalPot * (1 - (config.houseEdgePct / 100)));

    const refundedTicketIds = new Set(refundedParticipants.map((entry) => entry.ticketId));
    const activeByPlayer = new Map();
    for (const participant of activeParticipants) {
      const existing = activeByPlayer.get(participant.playerId) ?? {
        playerId: participant.playerId,
        name: participant.name,
        totalBet: 0,
        playCount: 0,
        recordedLoss: 0,
        payout: 0,
        winCount: 0,
      };
      existing.totalBet += Number(participant.amount ?? 0);
      existing.playCount += 1;
      if (participant.ticketId === winner?.ticketId) {
        existing.payout += payout;
        existing.winCount += 1;
      } else {
        existing.recordedLoss += Number(participant.amount ?? 0);
      }
      activeByPlayer.set(participant.playerId, existing);
    }

    for (const participant of snapshot.participants) {
      if (refundedTicketIds.has(participant.ticketId) || cancelled) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: participant.playerId, amount: participant.amount, config });
      }
    }

    if (!cancelled) {
      for (const group of activeByPlayer.values()) {
        await settle({
          gameServerId,
          moduleId: mod.moduleId,
          player: { id: group.playerId, name: group.name },
          config,
          game: 'race',
          betAmount: group.totalBet,
          payout: group.payout,
          playCount: group.playCount,
          winCount: group.winCount,
          recordedLoss: group.recordedLoss,
        });
      }
    }

    await withCasinoLocks(gameServerId, mod.moduleId, ['race-pool'], async () => {
      const current = await getRacePool(gameServerId, mod.moduleId);
      if ((current.participants?.length ?? 0) > 0 || current.status === 'drawing') {
        await setRacePool(gameServerId, mod.moduleId, emptyPool());
      }
    });

    if (cancelled) {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `🏁 Race cancelled — only ${activeParticipants.length} ${activeParticipants.length === 1 ? 'entry was' : 'entries were'} eligible in the pot, so everyone was refunded.`,
          opts: {},
        });
      } catch (err) {
        console.error(`casino.drawRace: failed to announce cancelled race: ${err}`);
      }
      console.log(`casino.drawRace: refunded undersized race pool${refundedParticipants.length > 0 ? ` after excluding ${refundedParticipants.length} banned ticket${refundedParticipants.length === 1 ? '' : 's'}` : ''}`);
    } else {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `🏁 DRAW: ${activeParticipants.length} players, pot ${formatCurrency(totalPot)} coin. Winner: ${winner?.name} (won ${formatCurrency(payout)} coin)!`,
          opts: {},
        });
      } catch (err) {
        console.error(`casino.drawRace: failed to announce race winner: ${err}`);
      }
      console.log(`casino.drawRace: winner=${winner?.name} payout=${formatCurrency(payout)} totalPot=${formatCurrency(totalPot)}${refundedParticipants.length > 0 ? ` refundedBannedTickets=${refundedParticipants.length}` : ''}`);
    }

  } catch (err) {
    console.error(`casino.drawRace: draw failed, preserved remaining participants for retry: ${err}`);
    throw err;
  }
}

await main();
