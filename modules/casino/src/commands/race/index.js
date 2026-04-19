import { data, TakaroUserError } from '@takaro/helpers';
import { getDefaultConfig, getRacePool, placeBet, refund, mutateRacePool, formatCurrency, formatFutureTime } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const currentPool = await getRacePool(gameServerId, mod.moduleId);
  if (currentPool.status === 'drawing') {
    throw new TakaroUserError('Race draw is currently being processed. Please wait for the result before joining the next round.');
  }
  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'race', amount: args.amount });
  let pool;
  try {
    pool = await mutateRacePool(gameServerId, mod.moduleId, async (current) => {
      const next = { participants: Array.isArray(current.participants) ? [...current.participants] : [], drawAt: current.drawAt, status: current.status ?? 'open' };
      if (next.status === 'drawing') {
        throw new TakaroUserError('Race draw is currently being processed. Please wait for the result before joining the next round.');
      }
      if (!next.drawAt || new Date(next.drawAt).getTime() <= Date.now()) {
        next.drawAt = new Date(Date.now() + (10 * 60 * 1000)).toISOString();
        next.participants = [];
        next.status = 'open';
      }
      next.participants.push({ playerId: player.id, name: player.name, amount: placed.amount });
      return next;
    });
  } catch (err) {
    await refund({ gameServerId, moduleId: mod.moduleId, playerId: player.id, amount: placed.amount, config });
    throw err;
  }
  const totalPot = pool.participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  await pog.pm(`🏁 Joined the race with ${formatCurrency(placed.amount)} coin. Pot: ${formatCurrency(totalPot)} across ${pool.participants.length} entries. Draw in about ${formatFutureTime(pool.drawAt)}.`);
}

await main();
