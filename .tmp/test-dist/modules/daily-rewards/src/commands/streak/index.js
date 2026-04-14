import { data, checkPermission } from '@takaro/helpers';
import {
  getPlayerDaily,
  getClaimStatus,
  formatTimeRemaining,
  isStreakAtRisk,
} from './daily-helpers.js';

async function main() {
  const { pog, gameServerId, player, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const dailyData = await getPlayerDaily(gameServerId, moduleId, player.id);
  const status = getClaimStatus(dailyData, config.streakGracePeriod);

  const multiplierPerm = checkPermission(pog, 'DAILY_REWARD_MULTIPLIER');
  const multiplier = (multiplierPerm && multiplierPerm.count > 0) ? multiplierPerm.count : 1;

  const effectiveStreak = status.streakAlive ? dailyData.currentStreak : 0;

  console.log(`streak: player=${player.name}, currentStreak=${dailyData.currentStreak}, bestStreak=${dailyData.bestStreak}, totalClaimed=${dailyData.totalClaimed}, canClaim=${status.canClaim}`);

  const lines = [`=== Daily Streak — ${player.name} ===`];

  if (!status.streakAlive && dailyData.currentStreak > 0) {
    lines.push(`📅 Current Streak: 0 days (streak expired)`);
  } else {
    lines.push(`📅 Current Streak: ${effectiveStreak} days`);
  }

  lines.push(`🏆 Best Streak: ${dailyData.bestStreak} days`);
  lines.push(`💰 Total Earned: ${dailyData.totalClaimed} coins`);

  if (multiplier > 1) {
    lines.push(`⚡ Your Multiplier: ${multiplier}x`);
  }

  if (dailyData.lastClaimAt === null && dailyData.currentStreak === 0) {
    lines.push(`✨ Use /daily to start your streak!`);
  } else if (status.canClaim) {
    // Show daily available BEFORE streak-expired note for natural reading order
    lines.push(`✅ Daily reward available! Use /daily to claim.`);

    if (!status.streakAlive && dailyData.currentStreak > 0) {
      lines.push(`💔 Your ${dailyData.currentStreak}-day streak has expired. Start fresh with /daily!`);
    } else {
      const riskInfo = isStreakAtRisk(status, config.streakGracePeriod);
      if (riskInfo.atRisk) {
        lines.push(`⚠️ Streak at risk! Expires in ${riskInfo.timeRemaining}. Claim soon!`);
      }
    }
  } else {
    const timeLeft = formatTimeRemaining(status.msUntilCanClaim);
    lines.push(`⏰ Next claim in: ${timeLeft}`);

    const riskInfo = isStreakAtRisk(status, config.streakGracePeriod);
    if (riskInfo.atRisk) {
      lines.push(`⚠️ Streak at risk! Expires in ${riskInfo.timeRemaining}. Claim soon!`);
    }
  }

  await pog.pm(lines.join('\n'));
}

await main();
