import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;

  // Paginate all casino_stats variables
  let allStats = [];
  let page = 0;
  const pageSize = 100;
  while (true) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { gameServerId: [gameServerId] },
      search: { key: ['casino_stats:'] },
      limit: pageSize,
      page,
    });
    const batch = res.data.data.filter(v => v.key.startsWith('casino_stats:'));
    if (!batch.length && page > 0) break;
    for (const v of batch) {
      try {
        const s = JSON.parse(v.value);
        const pId = v.key.replace('casino_stats:', '');
        // Try to get player name
        let name = pId;
        try {
          const pRes = await takaro.player.playerControllerGetOne(pId);
          name = pRes.data.data.name || pId;
        } catch {}
        allStats.push({ playerId: pId, name, ...s });
      } catch {}
    }
    if (res.data.data.length < pageSize) break;
    page++;
  }

  if (!allStats.length) return;

  // Top 10 wagered
  const topWager = allStats
    .filter(s => (s.wagered || 0) > 0)
    .sort((a, b) => (b.wagered || 0) - (a.wagered || 0))
    .slice(0, 10)
    .map(s => ({ name: s.name, wagered: s.wagered || 0 }));

  // Top 10 won (total payout)
  const topWon = allStats
    .filter(s => (s.won || 0) > 0)
    .sort((a, b) => (b.won || 0) - (a.won || 0))
    .slice(0, 10)
    .map(s => ({ name: s.name, won: s.won || 0 }));

  // Top 10 win rate (won/wagered, min 10 games)
  const topWinrate = allStats
    .filter(s => (s.gamesPlayed || 0) >= 10 && (s.wagered || 0) > 0)
    .map(s => ({ name: s.name, winrate: ((s.won / s.wagered) * 100).toFixed(1), gamesPlayed: s.gamesPlayed }))
    .sort((a, b) => parseFloat(b.winrate) - parseFloat(a.winrate))
    .slice(0, 10);

  // Top 10 biggest single win
  const topBiggest = allStats
    .filter(s => s.biggestWin && (s.biggestWin.amount || 0) > 0)
    .sort((a, b) => (b.biggestWin?.amount || 0) - (a.biggestWin?.amount || 0))
    .slice(0, 10)
    .map(s => ({ name: s.name, biggestWin: s.biggestWin?.amount || 0, biggestWinGame: s.biggestWin?.game || 'unknown' }));

  const cache = { topWager, topWon, topWinrate, topBiggest, refreshedAt: new Date().toISOString() };

  const existing = await takaro.variable.variableControllerSearch({ filters: { key: ['casino_leaderboard_cache'], gameServerId: [gameServerId] }, limit: 1 });
  if (existing.data.data.length) {
    await takaro.variable.variableControllerUpdate(existing.data.data[0].id, { value: JSON.stringify(cache) });
  } else {
    await takaro.variable.variableControllerCreate({ key: 'casino_leaderboard_cache', value: JSON.stringify(cache), gameServerId });
  }
}
await main();
