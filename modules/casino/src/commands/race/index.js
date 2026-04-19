import { data } from '@takaro/helpers';
import { getDefaultConfig, placeBet, getRacePool, setRacePool, formatCurrency } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'race', amount: args.amount });
  const pool = await getRacePool(gameServerId, mod.moduleId);
  if (!pool.drawAt || new Date(pool.drawAt).getTime() <= Date.now()) {
    pool.drawAt = new Date(Date.now() + (10 * 60 * 1000)).toISOString();
    pool.participants = [];
  }
  pool.participants.push({ playerId: player.id, name: player.name, amount: placed.amount });
  await setRacePool(gameServerId, mod.moduleId, pool);
  const totalPot = pool.participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  await pog.pm(`🏁 Joined the race with ${formatCurrency(placed.amount)} coin. Pot: ${formatCurrency(totalPot)} across ${pool.participants.length} entries. Draw at ${pool.drawAt}.`);
}

await main();
