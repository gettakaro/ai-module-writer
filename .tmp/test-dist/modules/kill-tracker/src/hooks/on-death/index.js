import { data, takaro, checkPermission } from '@takaro/helpers';
import {
  getPlayerStats,
  setPlayerStats,
  recordKill,
} from './tracker-helpers.js';

async function main() {
  const { gameServerId, eventData, player, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  // Process victim (the player who died); if this throws, attacker processing still runs below
  try {
    const victimStats = await getPlayerStats(gameServerId, moduleId, player.id);
    victimStats.deaths += 1;
    victimStats.points = Math.max(0, victimStats.points - config.deathPenalty);

    if (config.streakResetOnDeath) {
      victimStats.currentStreak = 0;
    }

    console.log(`on-death: victim=${player.name}, deaths=${victimStats.deaths}, points=${victimStats.points}, streak=${victimStats.currentStreak}`);
    await setPlayerStats(gameServerId, moduleId, player.id, victimStats);
  } catch (err) {
    console.error(`on-death: failed to process victim stats for ${player.name}: ${err} — continuing to attacker processing`);
  }

  // Process attacker if there is one and they are not the victim (suicide check)
  const attackerGameId = eventData && eventData.attacker && eventData.attacker.gameId;
  if (!attackerGameId || attackerGameId === player.gameId) {
    // No attacker, or self-kill — done
    return;
  }

  // Look up attacker by gameId on this game server
  let attackerPog;
  try {
    const searchResult = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameId: [attackerGameId],
        gameServerId: [gameServerId],
      },
    });
    attackerPog = searchResult.data.data.length > 0 ? searchResult.data.data[0] : null;
  } catch (err) {
    console.error(`on-death: failed to look up attacker with gameId=${attackerGameId}: ${err}`);
    return;
  }

  if (!attackerPog) {
    console.log(`on-death: attacker gameId=${attackerGameId} not found in Takaro — skipping PvP attribution`);
    return;
  }

  // Determine attacker multiplier
  const multiplierPerm = checkPermission(attackerPog, 'KILL_TRACKER_MULTIPLIER');
  const multiplier = (multiplierPerm && multiplierPerm.count > 0) ? multiplierPerm.count : 1;

  const attackerStats = await getPlayerStats(gameServerId, moduleId, attackerPog.playerId);
  const { pointsEarned, bonusAwarded } = recordKill(attackerStats, 'pvp', config, config.pvpKillPoints, multiplier);

  console.log(`on-death: attacker=${attackerPog.player?.name || attackerGameId}, pvpKills=${attackerStats.pvpKills}, streak=${attackerStats.currentStreak}, pointsEarned=${pointsEarned}, bonus=${bonusAwarded}, totalPoints=${attackerStats.points}`);

  // Save stats BEFORE any broadcasts so data is persisted even if broadcast fails
  await setPlayerStats(gameServerId, moduleId, attackerPog.playerId, attackerStats);

  if (bonusAwarded > 0 && config.streakBroadcast) {
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `${attackerPog.player?.name || attackerGameId} is on a ${attackerStats.currentStreak}-PvP-kill streak! (+${bonusAwarded} bonus points)`,
        opts: {},
      });
    } catch (err) {
      console.error(`on-death: failed to broadcast streak for ${attackerPog.player?.name || attackerGameId}: ${err}`);
    }
  }

  if (config.killBroadcast) {
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `${attackerPog.player?.name || attackerGameId} eliminated ${player.name} in PvP! (+${pointsEarned} points)`,
        opts: {},
      });
    } catch (err) {
      console.error(`on-death: failed to broadcast PvP kill for ${attackerPog.player?.name || attackerGameId}: ${err}`);
    }
  }

  if (config.awardCurrency && pointsEarned + bonusAwarded > 0) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, attackerPog.playerId, {
        currency: pointsEarned + bonusAwarded,
      });
    } catch (err) {
      console.error(`on-death: failed to award currency to attacker ${attackerPog.player?.name || attackerGameId}: ${err}`);
    }
  }
}

await main();
