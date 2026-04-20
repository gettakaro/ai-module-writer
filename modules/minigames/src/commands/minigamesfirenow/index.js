import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { getConfig, maybeFireLiveRound, normalizeOptionalStringArg, getGameDisplayName } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const config = getConfig(mod);
  const forcedGame = normalizeOptionalStringArg(args.game).toLowerCase() || undefined;
  const validGames = ['trivia', 'scramble', 'mathrace', 'reactionrace'];
  if (forcedGame && !validGames.includes(forcedGame)) {
    const message = `Unknown live game "${forcedGame}". Try: ${validGames.map((game) => getGameDisplayName(game)).join(', ')}.`;
    console.log(`minigames: ${message}`);
    await pog.pm(message);
    return;
  }
  if (forcedGame && !config.games[forcedGame]) {
    const message = `${getGameDisplayName(forcedGame)} is disabled on this server. Enabled live games: ${validGames.filter((game) => config.games[game]).map((game) => getGameDisplayName(game)).join(', ') || 'none'}.`;
    console.log(`minigames: ${message}`);
    await pog.pm(message);
    return;
  }

  const round = await maybeFireLiveRound({
    gameServerId,
    moduleId: mod.moduleId,
    config,
    forcedGame,
    ignoreThresholds: true,
  });
  if (!round) {
    const message = forcedGame
      ? `Could not fire ${forcedGame} right now. Check content banks or clear the active round first.`
      : 'Could not fire a round right now. Check content banks, enabled games, or clear the active round first.';
    console.log(`minigames: ${message}`);
    await pog.pm(message);
    return;
  }
  await pog.pm(`🚀 Fired ${getGameDisplayName(round.game)}.`);
}

await main();
