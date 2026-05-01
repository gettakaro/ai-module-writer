import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;

  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }

  const { category } = data.arguments;
  const cat = (category || '').toLowerCase().trim();
  if (!['wager', 'won', 'winrate', 'biggest'].includes(cat)) {
    throw new TakaroUserError('Category must be one of: wager, won, winrate, biggest');
  }

  const cacheRes = await takaro.variable.variableControllerSearch({ filters: { key: ['casino_leaderboard_cache'], gameServerId: [gameServerId] }, limit: 1 });
  const cache = cacheRes.data.data[0] ? JSON.parse(cacheRes.data.data[0].value) : null;

  if (!cache) {
    await pm('Leaderboard data is not yet available. It refreshes every 5 minutes.');
    return;
  }

  let list = [];
  let title = '';
  if (cat === 'wager')   { list = cache.topWager   ?? []; title = 'Top Wagerers'; }
  if (cat === 'won')     { list = cache.topWon     ?? []; title = 'Top Winners (payout)'; }
  if (cat === 'winrate') { list = cache.topWinrate ?? []; title = 'Best Win Rates'; }
  if (cat === 'biggest') { list = cache.topBiggest ?? []; title = 'Biggest Single Wins'; }

  if (!list.length) {
    await pm(`No data for ${cat} leaderboard yet.`);
    return;
  }

  const lines = [`=== Casino Leaderboard: ${title} ===`];
  list.forEach((entry, i) => {
    let val = '';
    if (cat === 'wager')   val = `${entry.wagered} wagered`;
    if (cat === 'won')     val = `${entry.won} won`;
    if (cat === 'winrate') val = `${entry.winrate}% win rate`;
    if (cat === 'biggest') val = `${entry.biggestWin} (${entry.biggestWinGame})`;
    lines.push(`${i + 1}. ${entry.name} — ${val}`);
  });

  const refreshed = cache.refreshedAt ? new Date(cache.refreshedAt).toLocaleTimeString() : 'unknown';
  lines.push(`Refreshed: ${refreshed}`);

  await pm(lines.join('\n'));
}
await main();
