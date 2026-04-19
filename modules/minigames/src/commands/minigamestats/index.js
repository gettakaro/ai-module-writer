import { data } from '@takaro/helpers';
import { getDailyWindow, getPlayerStats, findPlayerByName, getPlayerName, requirePlayable } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  const moduleId = mod.moduleId;
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });

  let targetId = player.id;
  let targetName = player.name;
  if (args.player) {
    const found = await findPlayerByName(args.player);
    if (!found) {
      await pog.pm(`Player "${args.player}" not found.`);
      return;
    }
    targetId = found.id;
    targetName = found.name;
  }

  const stats = await getPlayerStats(gameServerId, moduleId, targetId);
  const window = await getDailyWindow(gameServerId, moduleId, targetId);
  const name = targetName || await getPlayerName(targetId);
  await pog.pm([
    `📊 miniGames stats for ${name}`,
    `Total points: ${stats.totalPoints}`,
    `Games played: ${stats.gamesPlayed}`,
    `Today: ${window.earned} points`,
    `Wordle wins: ${stats.perGame.wordle.wins} | best streak: ${stats.streaks.wordle.best}`,
    `Hangman wins: ${stats.perGame.hangman.wins}`,
    `Live wins: trivia ${stats.perGame.trivia.wins}, scramble ${stats.perGame.scramble.wins}, math ${stats.perGame.mathrace.wins}, reaction ${stats.perGame.reactionrace.wins}`,
  ].join('\n'));
}

await main();
