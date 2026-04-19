import { data, TakaroUserError } from '@takaro/helpers';
import { getLeaderboardCache, refreshLeaderboardCache, formatCurrency } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const category = String(args.category ?? 'wager').toLowerCase();
  const map = {
    wager: ['topWager', 'wagered', 'Highest total wagered'],
    won: ['topWon', 'won', 'Highest total won'],
    winrate: ['topWinrate', 'winrate', 'Best payout ratio'],
    biggest: ['topBiggest', 'biggest', 'Biggest single payout'],
  };
  if (!map[category]) {
    throw new TakaroUserError('Choose wager, won, winrate, or biggest.');
  }

  let cache = await getLeaderboardCache(gameServerId, mod.moduleId);
  if (!cache.refreshedAt) {
    cache = await refreshLeaderboardCache(gameServerId, mod.moduleId);
  }

  const [key, field, title] = map[category];
  const rows = cache[key] ?? [];
  if (rows.length === 0) {
    await pog.pm('No casino leaderboard data yet.');
    return;
  }

  const lines = [`🏆 ${title}`];
  rows.forEach((row, index) => {
    const value = field === 'winrate' ? `${row[field]}%` : formatCurrency(row[field]);
    lines.push(`#${index + 1} ${row.name} — ${value}`);
  });
  await pog.pm(lines.join('\n'));
}

await main();
