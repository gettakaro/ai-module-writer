import { data, TakaroUserError } from '@takaro/helpers';
import { getDefaultConfig, getRacePool, setRacePool, placeBet, refund, formatCurrency, formatFutureTime, withCasinoLocks } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const pool = await withCasinoLocks(gameServerId, mod.moduleId, ['race-pool', `player:${player.id}`], async () => {
    const currentPool = await getRacePool(gameServerId, mod.moduleId);
    if (currentPool.status === 'drawing') {
      throw new TakaroUserError('Race draw is currently being processed. Please wait for the result before joining the next round.');
    }
    if (currentPool.drawAt && new Date(currentPool.drawAt).getTime() <= Date.now() && (currentPool.participants?.length ?? 0) > 0) {
      throw new TakaroUserError('The previous race draw is overdue and still needs to be settled. Please wait for the draw before joining the next round.');
    }

    const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'race', amount: args.amount, skipLock: true });
    try {
      const next = {
        participants: Array.isArray(currentPool.participants) ? [...currentPool.participants] : [],
        drawAt: currentPool.drawAt,
        status: currentPool.status ?? 'open',
      };
      if (!next.drawAt) {
        next.drawAt = new Date(Date.now() + (10 * 60 * 1000)).toISOString();
        next.status = 'open';
      }
      next.participants.push({
        ticketId: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        playerId: player.id,
        name: player.name,
        amount: placed.amount,
      });
      await setRacePool(gameServerId, mod.moduleId, next);
      return next;
    } catch (err) {
      await refund({ gameServerId, moduleId: mod.moduleId, playerId: player.id, amount: placed.amount, config, skipLock: true });
      throw err;
    }
  });
  const playerEntry = pool.participants[pool.participants.length - 1];
  const totalPot = pool.participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  await pog.pm(`🏁 Joined the race with ${formatCurrency(playerEntry.amount)} coin. Pot: ${formatCurrency(totalPot)} across ${pool.participants.length} entries. Draw in about ${formatFutureTime(pool.drawAt)}.`);
}

await main();
