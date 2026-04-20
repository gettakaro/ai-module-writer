import { data, takaro } from '@takaro/helpers';
import { getDefaultConfig, getRacePool, setRacePool, withCasinoLocks, pickWeightedWinner, settle, refund, formatCurrency } from './casino-helpers.js';

function emptyPool() {
  return {
    participants: [],
    drawAt: null,
    status: 'open',
  };
}

function removeParticipant(pool, ticketId) {
  const participants = (pool.participants ?? []).filter((entry) => entry.ticketId !== ticketId);
  return {
    ...pool,
    participants,
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
      const totalPot = participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
      const cancelled = participants.length < 2;
      const winner = cancelled ? null : pickWeightedWinner(participants);
      const payout = cancelled ? 0 : Math.round(totalPot * (1 - (config.houseEdgePct / 100)));

      await setRacePool(gameServerId, mod.moduleId, {
        ...pool,
        participants,
        status: 'drawing',
        totalPot,
        cancelled,
        winnerId: winner?.playerId ?? null,
        winnerName: winner?.name ?? null,
        payout,
      });

      return {
        participants,
        totalPot,
        cancelled,
        winnerId: winner?.playerId ?? null,
        winnerName: winner?.name ?? null,
        payout,
      };
    }

    return {
      participants,
      totalPot: Number(pool.totalPot ?? participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0)),
      cancelled: Boolean(pool.cancelled),
      winnerId: pool.winnerId ?? null,
      winnerName: pool.winnerName ?? null,
      payout: Number(pool.payout ?? 0),
    };
  });

  if (!snapshot) {
    console.log('casino.drawRace: nothing to draw');
    return;
  }

  try {
    for (const participant of snapshot.participants) {
      if (snapshot.cancelled) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: participant.playerId, amount: participant.amount, config });
      } else {
        await settle({
          gameServerId,
          moduleId: mod.moduleId,
          player: { id: participant.playerId, name: participant.name },
          config,
          game: 'race',
          betAmount: participant.amount,
          payout: participant.playerId === snapshot.winnerId ? Number(snapshot.payout ?? 0) : 0,
        });
      }

      await withCasinoLocks(gameServerId, mod.moduleId, ['race-pool'], async () => {
        const current = await getRacePool(gameServerId, mod.moduleId);
        if (current.status !== 'drawing') return;
        await setRacePool(gameServerId, mod.moduleId, removeParticipant(current, participant.ticketId));
      });
    }

    if (snapshot.cancelled) {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `🏁 Race cancelled — only ${snapshot.participants.length} ${snapshot.participants.length === 1 ? 'entry was' : 'entries were'} in the pot, so everyone was refunded.`,
          opts: {},
        });
      } catch (err) {
        console.error(`casino.drawRace: failed to announce cancelled race: ${err}`);
      }
      console.log('casino.drawRace: refunded undersized race pool');
    } else {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `🏁 DRAW: ${snapshot.participants.length} players, pot ${formatCurrency(snapshot.totalPot)} coin. Winner: ${snapshot.winnerName} (won ${formatCurrency(snapshot.payout)} coin)!`,
          opts: {},
        });
      } catch (err) {
        console.error(`casino.drawRace: failed to announce race winner: ${err}`);
      }
      console.log(`casino.drawRace: winner=${snapshot.winnerName} payout=${formatCurrency(snapshot.payout)} totalPot=${formatCurrency(snapshot.totalPot)}`);
    }

    await withCasinoLocks(gameServerId, mod.moduleId, ['race-pool'], async () => {
      const current = await getRacePool(gameServerId, mod.moduleId);
      if ((current.participants?.length ?? 0) === 0) {
        await setRacePool(gameServerId, mod.moduleId, emptyPool());
      }
    });
  } catch (err) {
    console.error(`casino.drawRace: draw failed, preserved remaining participants for retry: ${err}`);
    throw err;
  }
}

await main();
