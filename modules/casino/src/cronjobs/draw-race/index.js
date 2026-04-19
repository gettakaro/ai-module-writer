import { data } from '@takaro/helpers';
import { getDefaultConfig, mutateRacePool, pickWeightedWinner, settle, refund, formatCurrency } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  let snapshot = null;
  await mutateRacePool(gameServerId, mod.moduleId, async (pool) => {
    if (!pool.drawAt || new Date(pool.drawAt).getTime() > Date.now()) {
      return undefined;
    }
    snapshot = {
      participants: Array.isArray(pool.participants) ? [...pool.participants] : [],
      drawAt: pool.drawAt,
    };
    return { participants: [], drawAt: null };
  });
  if (!snapshot) {
    console.log('casino.drawRace: nothing to draw');
    return;
  }

  if (!Array.isArray(snapshot.participants) || snapshot.participants.length < 2) {
    for (const participant of snapshot.participants ?? []) {
      await refund({ gameServerId, moduleId: mod.moduleId, playerId: participant.playerId, amount: participant.amount, config });
    }
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
  console.log(`casino.drawRace: winner=${winner.name} payout=${formatCurrency(payout)} totalPot=${formatCurrency(totalPot)}`);
}

await main();
