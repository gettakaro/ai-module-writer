import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getPlayerDaily,
  setPlayerDaily,
  getClaimStatus,
  calculateReward,
  formatTimeRemaining,
} from './daily-helpers.js';

async function main() {
  const { pog, gameServerId, player, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  if (!checkPermission(pog, 'DAILY_CLAIM')) {
    throw new TakaroUserError('You do not have permission to claim daily rewards.');
  }

  const multiplierPerm = checkPermission(pog, 'DAILY_REWARD_MULTIPLIER');
  const multiplier = (multiplierPerm && multiplierPerm.count > 0) ? multiplierPerm.count : 1;

  const dailyData = await getPlayerDaily(gameServerId, moduleId, player.id);
  const status = getClaimStatus(dailyData, config.streakGracePeriod);

  if (!status.canClaim) {
    const timeLeft = formatTimeRemaining(status.msUntilCanClaim);
    throw new TakaroUserError(`You already claimed your daily reward! Come back in ${timeLeft}. Check /streak for your streak info.`);
  }

  let newStreak;
  if (dailyData.lastClaimAt === null) {
    newStreak = 1;
  } else if (!status.streakAlive) {
    newStreak = 1;
    console.log(`daily: streak reset for player=${player.name} (grace period expired)`);
  } else {
    newStreak = dailyData.currentStreak + 1;
  }

  const oldBestStreak = dailyData.bestStreak;
  const newBestStreak = Math.max(oldBestStreak, newStreak);

  const { totalReward, milestoneBonus, milestoneMessage } = calculateReward(
    config.baseReward,
    newStreak,
    multiplier,
    config.milestoneRewards,
    config.maxStreak,
  );

  const newData = {
    lastClaimAt: new Date().toISOString(),
    currentStreak: newStreak,
    bestStreak: newBestStreak,
    // NOTE: totalClaimed is not atomic — rapid concurrent claims can cause undercounting.
    // This is an inherent limitation of Takaro's variable storage (no transactions).
    totalClaimed: (dailyData.totalClaimed || 0) + totalReward,
  };

  await setPlayerDaily(gameServerId, moduleId, player.id, newData);

  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, player.id, {
      currency: totalReward,
    });
  } catch (currencyErr) {
    console.error(`daily: currency grant failed for player=${player.name}, reverting claim. Error: ${currencyErr}`);
    try {
      await setPlayerDaily(gameServerId, moduleId, player.id, dailyData);
    } catch (rollbackErr) {
      // Rollback failed — player data may be in an inconsistent state. Log clearly for operators.
      console.error(`daily: CRITICAL rollback failed for player=${player.name}. Data may be inconsistent. Error: ${rollbackErr}`);
    }
    throw new TakaroUserError('Failed to grant your reward due to a server error. Please try again.');
  }

  console.log(`daily: claimed player=${player.name}, streak=${newStreak}, reward=${totalReward}, multiplier=${multiplier}, milestoneBonus=${milestoneBonus}`);

  const isNewBest = newStreak > oldBestStreak;
  const lines = [`✅ Daily reward claimed! You earned ${totalReward} coins.`];
  lines.push(`📅 ${newStreak}-day streak${isNewBest ? ' (new best!)' : ''}`);

  if (config.showMultiplierInClaim && multiplier > 1) {
    lines.push(`⚡ Multiplier: ${multiplier}x applied`);
  }

  if (milestoneMessage) {
    lines.push(milestoneMessage);
  }

  lines.push(`⏰ Next reward available in ~24 hours.`);

  await pog.pm(lines.join('\n'));
}

await main();
