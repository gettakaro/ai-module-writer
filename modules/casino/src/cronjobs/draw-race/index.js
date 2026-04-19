import { data } from '@takaro/helpers';
import { getDefaultConfig, mutateRacePool, pickWeightedWinner, settle, refund, formatCurrency } from './casino-helpers.js';

function emptyPool() {
  return {
    participants: [],
    drawAt: null,
    status: 'open',
    drawId: null,
    winnerId: null,
    winnerName: null,
    payout: null,
    totalPot: null,
    settledPlayerIds: [],
    cancelled: false,
  };
}

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);

  let snapshot = await mutateRacePool(gameServerId, mod.moduleId, async (pool) => {
    const participants = Array.isArray(pool.participants) ? [...pool.participants] : [];
    const due = pool.drawAt && new Date(pool.drawAt).getTime() <= Date.now();
    const recoverableDrawing = pool.status === 'drawing' && participants.length > 0;
    if (!recoverableDrawing && !due) {
      return undefined;
    }

    if (recoverableDrawing) {
      return {
        ...pool,
        participants,
        settledPlayerIds: Array.isArray(pool.settledPlayerIds) ? [...pool.settledPlayerIds] : [],
      };
    }

    const totalPot = participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
    const cancelled = participants.length < 2;
    const winner = cancelled ? null : pickWeightedWinner(participants);
    const payout = cancelled ? 0 : Math.round(totalPot * (1 - (config.houseEdgePct / 100)));
    return {
      ...pool,
      participants,
      status: 'drawing',
      drawId: pool.drawId ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`,
      winnerId: winner?.playerId ?? null,
      winnerName: winner?.name ?? null,
      payout,
      totalPot,
      settledPlayerIds: Array.isArray(pool.settledPlayerIds) ? [...pool.settledPlayerIds] : [],
      cancelled,
    };
  });

  if (!snapshot) {
    console.log('casino.drawRace: nothing to draw');
    return;
  }

  try {
    const settledPlayerIds = new Set(Array.isArray(snapshot.settledPlayerIds) ? snapshot.settledPlayerIds : []);
    const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];

    for (const participant of participants) {
      if (settledPlayerIds.has(participant.playerId)) continue;

      if (snapshot.cancelled) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: participant.playerId, amount: participant.amount, config });
      } else {
        const participantPayout = participant.playerId === snapshot.winnerId ? Number(snapshot.payout ?? 0) : 0;
        await settle({
          gameServerId,
          moduleId: mod.moduleId,
          player: { id: participant.playerId, name: participant.name },
          config,
          game: 'race',
          betAmount: participant.amount,
          payout: participantPayout,
        });
      }

      snapshot = await mutateRacePool(gameServerId, mod.moduleId, async (pool) => ({
        ...pool,
        settledPlayerIds: [...new Set([...(pool.settledPlayerIds ?? []), participant.playerId])],
      }));
    }

    await mutateRacePool(gameServerId, mod.moduleId, async () => emptyPool());
    if (snapshot.cancelled) {
      console.log('casino.drawRace: refunded undersized race pool');
      return;
    }
    console.log(`casino.drawRace: winner=${snapshot.winnerName} payout=${formatCurrency(snapshot.payout)} totalPot=${formatCurrency(snapshot.totalPot)}`);
  } catch (err) {
    console.error(`casino.drawRace: draw failed, preserved pool progress for retry: ${err}`);
    throw err;
  }
}

await main();
