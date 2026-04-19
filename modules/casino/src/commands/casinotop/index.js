import { data, TakaroUserError } from '@takaro/helpers';
import { getLeaderboardCache, formatCurrency, formatPastTime } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const category = String(args.category ?? 'wager').toLowerCase();
  const map = {
    wager: ['topWager', 'wagered', 'Highest total wagered'],
    won: ['topWon', 'won', 'Highest total won'],
    winrate: ['topWinrate', 'winrate', 'Best win rate (winning rounds ÷ games played)'],
    roi: ['topRoi', 'roi', 'Best payout ratio (won ÷ wagered)'],
    biggest: ['topBiggest', 'biggest', 'Biggest single payout'],
  };
  if (!map[category]) {
    throw new TakaroUserError('Choose wager, won, winrate, roi, or biggest.');
  }

  const cache = await getLeaderboardCache(gameServerId, mod.moduleId);
  const refreshedAt = cache.refreshedAt ? new Date(cache.refreshedAt).getTime() : 0;
  const stale = Boolean(refreshedAt) && (Date.now() - refreshedAt > 5 * 60 * 1000);

  const [key, field, title] = map[category];
  const rows = cache[key] ?? [];
  const lines = [`🏆 ${title}`];
  if (cache.refreshedAt) {
    lines.push(`Cache refreshed ${formatPastTime(cache.refreshedAt)}${stale ? ' — waiting for the next cron refresh.' : ''}`);
  }
  if (rows.length === 0) {
    lines.push('No casino leaderboard data yet. Wait for the refresh-leaderboards cronjob to populate the cache.');
    await pog.pm(lines.join('\n'));
    return;
  }
  rows.forEach((row, index) => {
    const raw = row[field];
    const value = field === 'roi' || field === 'winrate' ? `${raw}%` : formatCurrency(raw);
    lines.push(`#${index + 1} ${row.name} — ${value}`);
  });
  await pog.pm(lines.join('\n'));
}

await main();
