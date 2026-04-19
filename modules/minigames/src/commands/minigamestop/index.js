import { data, TakaroUserError } from '@takaro/helpers';
import { getLeaderboardCache, refreshLeaderboards, renderLeaderboard, requirePlayable, normalizeOptionalStringArg } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  const moduleId = mod.moduleId;
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  const category = normalizeOptionalStringArg(args.category).toLowerCase();
  if (!category) throw new TakaroUserError('Usage: /minigamestop <points|wordle|hangman|streak> (legacy alias for /minigamesleaderboard)');

  let cache = await getLeaderboardCache(gameServerId, moduleId);
  if (!cache.refreshedAt) cache = await refreshLeaderboards(gameServerId, moduleId);

  const map = {
    points: ['🏆 Top points', cache.topPoints],
    wordle: ['🟩 Top Wordle wins', cache.topWordle],
    hangman: ['🎪 Top Hangman wins', cache.topHangman],
    streak: ['🔥 Top Wordle streaks', cache.topStreak],
  };
  const selected = map[category];
  if (!selected) throw new TakaroUserError('Category must be one of: points, wordle, hangman, streak.');
  const message = renderLeaderboard(selected[0], selected[1]);
  await pog.pm(message);
  console.log(`minigames: leaderboard alias=minigamestop category=${category} summary=${message.replace(/\n/g, ' | ')}`);
}

await main();
