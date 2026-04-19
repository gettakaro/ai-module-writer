import { data } from '@takaro/helpers';
import { getDefaultConfig, getRacePool, setRacePool, pickWeightedWinner, settle, refund, formatCurrency } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const pool = await getRacePool(gameServerId, mod.moduleId);
  if (!pool.drawAt || new Date(pool.drawAt).getTime() > Date.now()) {
    console.log('casino.drawRace: nothing to draw');
    return;
  }

  if (!Array.isArray(pool.participants) || pool.participants.length < 2) {
    for (const participant of pool.participants ?? []) {
      await refund({ gameServerId, moduleId: mod.moduleId, playerId: participant.playerId, amount: participant.amount, config });
    }
    await setRacePool(gameServerId, mod.moduleId, { participants: [], drawAt: null });
    console.log('casino.drawRace: refunded undersized race pool');
    return;
  }

  const totalPot = pool.participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  const winner = pickWeightedWinner(pool.participants);
  const payout = Math.round(totalPot * (1 - (config.houseEdgePct / 100)));
  for (const participant of pool.participants) {
    if (participant.playerId === winner.playerId) {
      await settle({ gameServerId, moduleId: mod.moduleId, player: { id: participant.playerId, name: participant.name }, config, game: 'race', betAmount: participant.amount, payout });
    } else {
      await settle({ gameServerId, moduleId: mod.moduleId, player: { id: participant.playerId, name: participant.name }, config, game: 'race', betAmount: participant.amount, payout: 0 });
    }
  }
  await setRacePool(gameServerId, mod.moduleId, { participants: [], drawAt: null });
  console.log(`casino.drawRace: winner=${winner.name} payout=${formatCurrency(payout)} totalPot=${formatCurrency(totalPot)}`);
}

await main();
