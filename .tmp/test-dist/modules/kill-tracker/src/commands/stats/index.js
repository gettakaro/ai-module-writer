import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getPlayerStats,
  getAllPlayerStats,
  getSeasonInfo,
  formatKD,
  sortByRank,
} from './tracker-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  const moduleId = mod.moduleId;

  if (!checkPermission(pog, 'KILL_TRACKER_VIEW_STATS')) {
    throw new TakaroUserError('You do not have permission to view kill stats.');
  }

  // Known scaling limitation: getAllPlayerStats fetches all player records to compute rank.
  // Acceptable for typical game server sizes (< a few thousand players).
  const [stats, allStats, season] = await Promise.all([
    getPlayerStats(gameServerId, moduleId, player.id),
    getAllPlayerStats(gameServerId, moduleId),
    getSeasonInfo(gameServerId, moduleId),
  ]);

  // Compute rank (1-based, sorted by points desc, then kills as tiebreaker)
  const sorted = sortByRank(allStats);

  const rankIndex = sorted.findIndex((entry) => entry.playerId === player.id);
  // rankIndex === -1 means the player has no stored stats yet — show "Unranked"
  const rankDisplay = rankIndex === -1 ? 'Unranked' : `#${rankIndex + 1}/${allStats.length}`;

  const kd = formatKD(stats.kills, stats.deaths);

  const isNewPlayer = stats.kills === 0 && stats.deaths === 0 && stats.points === 0;

  const lines = [
    `=== Kill Stats: ${player.name} — Season ${season.number} ===`,
    `Points: ${stats.points} | Rank: ${rankDisplay}`,
    `Kills: ${stats.kills} (PvP: ${stats.pvpKills} | Mob: ${stats.mobKills})`,
    `Deaths: ${stats.deaths} | K/D: ${kd}`,
    `Current Streak: ${stats.currentStreak} | Best Streak: ${stats.bestStreak}`,
  ];

  if (isNewPlayer) {
    lines.push('Start killing to earn points and climb the leaderboard!');
  }

  console.log(`stats: player=${player.name}, points=${stats.points}, rank=${rankDisplay}, kills=${stats.kills}, deaths=${stats.deaths}`);

  await pog.pm(lines.join('\n'));
}

await main();
