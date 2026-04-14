import { data, takaro } from '@takaro/helpers';
import { getAllPlayerDaily, getClaimStatus } from './daily-helpers.js';

// No permission check: /topstreak is a public read-only leaderboard, same as /streak.
// This is intentional — anyone can see the rankings.

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const count = Math.min(25, Math.max(1, Math.floor(args.count || 10)));

  const allRecords = await getAllPlayerDaily(gameServerId, moduleId);

  if (allRecords.length === 0) {
    console.log(`topstreak: no daily data recorded yet`);
    await pog.pm('No streak data yet. Be the first to claim your daily reward with /daily!');
    return;
  }

  const recordsWithStatus = allRecords.map((entry) => {
    const status = getClaimStatus(entry.daily, config.streakGracePeriod);
    const effectiveCurrentStreak = status.streakAlive ? entry.daily.currentStreak : 0;
    return { ...entry, effectiveCurrentStreak };
  });

  const sorted = [...recordsWithStatus].sort((a, b) => {
    if (b.daily.bestStreak !== a.daily.bestStreak) return b.daily.bestStreak - a.daily.bestStreak;
    return b.effectiveCurrentStreak - a.effectiveCurrentStreak;
  });

  const topEntries = sorted.slice(0, count);

  const playerNames = await Promise.all(
    topEntries.map(async (entry) => {
      try {
        const res = await takaro.player.playerControllerGetOne(entry.playerId);
        return res.data.data.name || entry.playerId;
      } catch (err) {
        console.error(`topstreak: failed to resolve name for player ${entry.playerId}: ${err}`);
        return entry.playerId;
      }
    }),
  );

  const totalPlayers = allRecords.length;
  const showing = topEntries.length;
  console.log(`topstreak: showing top ${showing} of ${count} requested players (of ${totalPlayers} total)`);

  // Show "(all players)" suffix when results < requested to avoid a misleading "Top N" label
  const headerDetail = showing < count
    ? `Top ${showing} — all players`
    : `Top ${showing}`;

  const lines = [`=== Daily Streaks — ${headerDetail} ===`];
  for (let i = 0; i < topEntries.length; i++) {
    const entry = topEntries[i];
    const name = playerNames[i];
    lines.push(`#${i + 1} ${name} | Best: ${entry.daily.bestStreak} days | Current: ${entry.effectiveCurrentStreak} days`);
  }

  await pog.pm(lines.join('\n'));
}

await main();
