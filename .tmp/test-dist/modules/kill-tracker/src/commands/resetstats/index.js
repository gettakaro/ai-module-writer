import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  deleteAllPlayerStats,
  deletePlayerStats,
  getSeasonInfo,
  setSeasonInfo,
} from './tracker-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const moduleId = mod.moduleId;

  if (!checkPermission(pog, 'KILL_TRACKER_RESET')) {
    throw new TakaroUserError('You do not have permission to reset kill stats.');
  }

  const targetName = args.player && args.player.trim();

  // Require explicit argument: "?" is the sentinel default — show usage if omitted.
  if (!targetName || targetName === '?') {
    throw new TakaroUserError(
      'Please specify a target. Use "/resetstats all" to reset all stats and start a new season, or "/resetstats <player>" to reset a specific player.',
    );
  }

  if (targetName === 'all') {
    // Full reset: delete all stats and increment season
    await deleteAllPlayerStats(gameServerId, moduleId);

    const season = await getSeasonInfo(gameServerId, moduleId);
    const newSeasonNumber = season.number + 1;
    await setSeasonInfo(gameServerId, moduleId, {
      number: newSeasonNumber,
      startedAt: new Date().toISOString(),
    });

    console.log(`resetstats: full reset by ${player.name}, new season=${newSeasonNumber}`);

    await pog.pm(`Season ${newSeasonNumber} has begun! All kill stats have been reset.`);

    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `Season ${newSeasonNumber} has begun! All kill stats have been reset.`,
        opts: {},
      });
    } catch (err) {
      console.error(`resetstats: failed to broadcast season start: ${err}`);
    }
  } else {
    // Per-player reset: find player by name, delete their stats
    const playerSearch = await takaro.player.playerControllerSearch({
      search: { name: [targetName] },
    });

    const found = playerSearch.data.data.find(
      (p) => p.name.toLowerCase() === targetName.toLowerCase(),
    );

    if (!found) {
      throw new TakaroUserError(`Player "${targetName}" not found.`);
    }

    const season = await getSeasonInfo(gameServerId, moduleId);

    const hadStats = await deletePlayerStats(gameServerId, moduleId, found.id);

    console.log(`resetstats: reset stats for player=${found.name} (id=${found.id}) by ${player.name}, hadStats=${hadStats}`);

    if (hadStats) {
      await pog.pm(`Kill stats for "${found.name}" have been reset (Season ${season.number}).`);
    } else {
      await pog.pm(`"${found.name}" had no recorded stats this season.`);
    }
  }
}

await main();
