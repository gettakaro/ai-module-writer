import { data } from '@takaro/helpers';
import { getDefaultConfig, mutateRacePool, pickWeightedWinner, settle, refund, formatCurrency } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  let snapshot = null;

  await mutateRacePool(gameServerId, mod.moduleId, async (pool) => {
    const participants = Array.isArray(pool.participants) ? [...pool.participants] : [];
    const due = pool.drawAt && new Date(pool.drawAt).getTime() <= Date.now();
    const recoverableDrawing = pool.status === 'drawing' && participants.length > 0;
    if (!recoverableDrawing && !due) {
      return undefined;
    }
    snapshot = {
      participants,
      drawAt: pool.drawAt,
      status: pool.status ?? 'open',
    };
    if (recoverableDrawing) {
      return undefined;
    }
    return { ...pool, participants, status: 'drawing' };
  });

  if (!snapshot) {
    console.log('casino.drawRace: nothing to draw');
    return;
  }

  try {
    if (!Array.isArray(snapshot.participants) || snapshot.participants.length < 2) {
      for (const participant of snapshot.participants ?? []) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: participant.playerId, amount: participant.amount, config });
      }
      await mutateRacePool(gameServerId, mod.moduleId, async () => ({ participants: [], drawAt: null, status: 'open' }));
      console.log('casino.drawRace: refunded undersized race pool');
      return;
    }

    const totalPot = snapshot.participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
    const winner = pickWeightedWinner(snapshot.participants);
    const payout = Math.round(totalPot * (1 - (config.houseEdgePct / 100)));
    for (const participant of snapshot.participants) {
      if (participant.playerId === winner.playerId) {
        await settle({ gameServerId, moduleId: mod.moduleId, player: { id: participant.playerId, name: participant.name }, config, game: 'race', betAmount: participant.amount, payout });
      } else {
        await settle({ gameServerId, moduleId: mod.moduleId, player: { id: participant.playerId, name: participant.name }, config, game: 'race', betAmount: participant.amount, payout: 0 });
      }
    }
    await mutateRacePool(gameServerId, mod.moduleId, async () => ({ participants: [], drawAt: null, status: 'open' }));
    console.log(`casino.drawRace: winner=${winner.name} payout=${formatCurrency(payout)} totalPot=${formatCurrency(totalPot)}`);
  } catch (err) {
    console.error(`casino.drawRace: draw failed, preserved pool for retry: ${err}`);
    throw err;
  }
}

await main();
