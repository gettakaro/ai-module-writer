import { data } from '@takaro/helpers';
import { listStatsEntries, getPlayerName } from './referral-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;

  const entries = await listStatsEntries(gameServerId, mod.moduleId);
  const ranked = entries
    .filter((entry) => entry.stats.referralsPaid > 0)
    .sort((a, b) => {
      if (b.stats.referralsPaid !== a.stats.referralsPaid) return b.stats.referralsPaid - a.stats.referralsPaid;
      return b.stats.referralsTotal - a.stats.referralsTotal;
    })
    .slice(0, 10);

  if (ranked.length === 0) {
    console.log('referral-program: leaderboard empty');
    await pog.pm('Referral leaderboard is empty. Be the first to complete a referral!');
    return;
  }

  const names = await Promise.all(ranked.map((entry) => getPlayerName(entry.playerId)));
  const lines = ['Referral leaderboard:'];
  ranked.forEach((entry, index) => {
    lines.push(`${index + 1}. ${names[index]} — paid=${entry.stats.referralsPaid}, total=${entry.stats.referralsTotal}`);
  });

  console.log(`referral-program: leaderboard ${lines.slice(1).join(' | ')}`);
  await pog.pm(lines.join('\n'));
}

await main();
