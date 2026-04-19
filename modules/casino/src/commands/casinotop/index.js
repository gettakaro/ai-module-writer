import { data, TakaroUserError } from '@takaro/helpers';
import { getLeaderboardCache, refreshLeaderboardCache, formatCurrency } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const category = String(args.category ?? 'wager').toLowerCase();
  const map = {
    wager: ['topWager', 'wagered', 'Highest total wagered'],
    won: ['topWon', 'won', 'Highest total won'],
    winrate: ['topRoi', 'roi', 'Best payout ratio (won ÷ wagered)'],
    roi: ['topRoi', 'roi', 'Best payout ratio (won ÷ wagered)'],
    biggest: ['topBiggest', 'biggest', 'Biggest single payout'],
  };
  if (!map[category]) {
    throw new TakaroUserError('Choose wager, won, roi, winrate, or biggest.');
  }

  let cache = await getLeaderboardCache(gameServerId, mod.moduleId);
  const refreshedAt = cache.refreshedAt ? new Date(cache.refreshedAt).getTime() : 0;
  const stale = !refreshedAt || (Date.now() - refreshedAt > 5 * 60 * 1000);
  const empty = (cache.topWager?.length ?? 0) === 0 && (cache.topWon?.length ?? 0) === 0 && ((cache.topRoi?.length ?? cache.topWinrate?.length ?? 0) === 0) && (cache.topBiggest?.length ?? 0) === 0;
  if (stale || empty) {
    cache = await refreshLeaderboardCache(gameServerId, mod.moduleId);
  }

  const [key, field, title] = map[category];
  const rows = cache[key] ?? (key === 'topRoi' ? cache.topWinrate ?? [] : []);
  if (rows.length === 0) {
    await pog.pm('No casino leaderboard data yet.');
    return;
  }

  const lines = [`🏆 ${title}`];
  rows.forEach((row, index) => {
    const raw = row[field] ?? (field === 'roi' ? row.winrate : undefined);
    const value = field === 'roi' ? `${raw}%` : formatCurrency(raw);
    lines.push(`#${index + 1} ${row.name} — ${value}`);
  });
  await pog.pm(lines.join('\n'));
}

await main();
