import { data } from '@takaro/helpers';
import { getDefaultConfig, placeBet, mutateRacePool, formatCurrency, formatFutureTime } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'race', amount: args.amount });
  const pool = await mutateRacePool(gameServerId, mod.moduleId, async (current) => {
    const next = { participants: Array.isArray(current.participants) ? [...current.participants] : [], drawAt: current.drawAt };
    if (!next.drawAt || new Date(next.drawAt).getTime() <= Date.now()) {
      next.drawAt = new Date(Date.now() + (10 * 60 * 1000)).toISOString();
      next.participants = [];
    }
    next.participants.push({ playerId: player.id, name: player.name, amount: placed.amount });
    return next;
  });
  const totalPot = pool.participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  await pog.pm(`🏁 Joined the race with ${formatCurrency(placed.amount)} coin. Pot: ${formatCurrency(totalPot)} across ${pool.participants.length} entries. Draw in about ${formatFutureTime(pool.drawAt)}.`);
}

await main();
