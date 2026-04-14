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

  // PvP kills (victim has gameId) are handled by on-death hook; skip here.
  if (eventData && eventData.victim && eventData.victim.gameId) {
    console.log(`on-kill: skipping PvP kill, victim is a player (gameId=${eventData.victim.gameId})`);
    return;
  }

  // Fetch the player-on-gameserver record to check permissions
  let pog;
  try {
    pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, player.id)).data.data;
  } catch (err) {
    console.error(`on-kill: failed to fetch pog for player ${player.name}: ${err} — defaulting multiplier to 1`);
    pog = null;
  }

  // Determine multiplier from KILL_TRACKER_MULTIPLIER permission
  const multiplierPerm = pog ? checkPermission(pog, 'KILL_TRACKER_MULTIPLIER') : null;
  const multiplier = (multiplierPerm && multiplierPerm.count > 0) ? multiplierPerm.count : 1;

  const stats = await getPlayerStats(gameServerId, moduleId, player.id);

  const { pointsEarned, bonusAwarded } = recordKill(stats, 'mob', config, config.mobKillPoints, multiplier);

  console.log(`on-kill: mob kill player=${player.name}, mobKills=${stats.mobKills}, streak=${stats.currentStreak}, pointsEarned=${pointsEarned}, bonus=${bonusAwarded}, totalPoints=${stats.points}`);

  // Save stats BEFORE any broadcasts so data is persisted even if broadcast fails
  await setPlayerStats(gameServerId, moduleId, player.id, stats);

  if (bonusAwarded > 0 && config.streakBroadcast) {
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `${player.name} is on a ${stats.currentStreak}-mob-kill streak! (+${bonusAwarded} bonus points)`,
        opts: {},
      });
    } catch (err) {
      console.error(`on-kill: failed to broadcast mob streak for ${player.name}: ${err}`);
    }
  }

  if (config.awardCurrency && pointsEarned + bonusAwarded > 0) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, player.id, {
        currency: pointsEarned + bonusAwarded,
      });
    } catch (err) {
      console.error(`on-kill: failed to award currency to player ${player.name}: ${err}`);
    }
  }
}

await main();
