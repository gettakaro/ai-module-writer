import { data, takaro } from '@takaro/helpers';
import {
  getPlayerDaily,
  getClaimStatus,
  isStreakAtRisk,
} from './daily-helpers.js';

async function main() {
  const { gameServerId, player, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  if (!config.notifyOnLogin) {
    console.log(`dailyLoginCheck: notifyOnLogin disabled, skipping`);
    return;
  }

  // Wrap notification logic in try-catch: this hook is non-critical.
  // If the API calls fail, log and return gracefully rather than crashing.
  try {
    const dailyData = await getPlayerDaily(gameServerId, moduleId, player.id);
    const status = getClaimStatus(dailyData, config.streakGracePeriod);

    if (!status.canClaim) {
      console.log(`dailyLoginCheck: no notification for player=${player.name}, canClaim=${status.canClaim}`);
      return;
    }

    let message;

    if (!status.streakAlive && dailyData.currentStreak > 0) {
      // Streak has expired since last visit — warn the player when they log in
      message = `Welcome back, ${player.name}! Your ${dailyData.currentStreak}-day streak has expired. Start fresh with /daily!`;
    } else {
      const streakInfo = dailyData.currentStreak > 0 && status.streakAlive
        ? ` (${dailyData.currentStreak}-day streak!)` : '';
      message = `Welcome back, ${player.name}! Your daily reward is available${streakInfo}. Use /daily to claim it!`;

      const riskInfo = isStreakAtRisk(status, config.streakGracePeriod);
      if (riskInfo.atRisk) {
        message += ` ⚠️ Streak expires in ${riskInfo.timeRemaining}!`;
      }
    }

    console.log(`dailyLoginCheck: daily available for player=${player.name}, streak=${dailyData.currentStreak}, streakAlive=${status.streakAlive}`);

    const pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, player.id)).data.data;
    await pog.pm(message);
  } catch (err) {
    console.error(`dailyLoginCheck: notification failed for player=${player.name}. Error: ${err}`);
  }
}

await main();
