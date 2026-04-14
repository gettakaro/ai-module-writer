import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getAllPlayerStats,
  getSeasonInfo,
  formatKD,
  sortByRank,
} from './tracker-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  if (!checkPermission(pog, 'KILL_TRACKER_VIEW_STATS')) {
    throw new TakaroUserError('You do not have permission to view the leaderboard.');
  }

  const pageSize = config.leaderboardPageSize || 10;
  const page = Math.floor(Math.max(1, args.page || 1));

  const [allStats, season] = await Promise.all([
    getAllPlayerStats(gameServerId, moduleId),
    getSeasonInfo(gameServerId, moduleId),
  ]);

  if (allStats.length === 0) {
    console.log(`leaderboard: no stats recorded yet, season=${season.number}`);
    await pog.pm(`No stats recorded yet in Season ${season.number}. Go get some kills!`);
    return;
  }

  const sorted = sortByRank(allStats);

  const totalPages = Math.ceil(sorted.length / pageSize);
  if (page > totalPages) {
    throw new TakaroUserError(`Page ${page} does not exist. There ${totalPages === 1 ? 'is' : 'are'} only ${totalPages} ${totalPages === 1 ? 'page' : 'pages'}.`);
  }

  const startIndex = (page - 1) * pageSize;
  const pageEntries = sorted.slice(startIndex, startIndex + pageSize);

  // Resolve player names for this page in parallel
  const playerNames = await Promise.all(
    pageEntries.map(async (entry) => {
      try {
        const res = await takaro.player.playerControllerGetOne(entry.playerId);
        return res.data.data.name || entry.playerId;
      } catch (err) {
        console.error(`leaderboard: failed to resolve name for player ${entry.playerId}: ${err}`);
        return entry.playerId;
      }
    }),
  );

  const pagePoints = pageEntries.reduce((sum, e) => sum + e.stats.points, 0);
  console.log(`leaderboard: page=${page}/${totalPages}, players=${pageEntries.length}, season=${season.number}, pagePoints=${pagePoints}`);

  const lines = [`=== Top Players (Season ${season.number}) — Page ${page}/${totalPages} ===`];
  for (let i = 0; i < pageEntries.length; i++) {
    const entry = pageEntries[i];
    const rank = startIndex + i + 1;
    const name = playerNames[i];
    const kd = formatKD(entry.stats.kills, entry.stats.deaths);
    lines.push(`#${rank} ${name} | ${entry.stats.points} pts | K/D: ${kd}`);
  }

  if (page < totalPages) {
    // Note: '/top' is hardcoded here because modules cannot access the server's configured command
    // prefix at runtime. The standard prefix '/' is used as a fallback. Admins using a custom
    // prefix will need to substitute accordingly.
    lines.push(`Use /top ${page + 1} to see the next page.`);
  }

  await pog.pm(lines.join('\n'));
}

await main();
