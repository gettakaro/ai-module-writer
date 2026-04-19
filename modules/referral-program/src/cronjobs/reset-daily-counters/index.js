import { data } from '@takaro/helpers';
import { listStatsEntries, setReferralStats, getTodayKey } from './referral-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const entries = await listStatsEntries(gameServerId, mod.moduleId);
  const today = getTodayKey();

  for (const entry of entries) {
    if (entry.stats.referralsToday !== 0 || entry.stats.lastReferralDay !== today) {
      await setReferralStats(gameServerId, mod.moduleId, entry.playerId, {
        ...entry.stats,
        referralsToday: 0,
      });
    }
  }

  console.log(`referral-program: reset-daily-counters processed=${entries.length}`);
}

await main();
