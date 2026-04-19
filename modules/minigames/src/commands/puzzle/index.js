import { data } from '@takaro/helpers';
import { getConfig, getPuzzleToday, getWordleSession, getHangmanSession, getHotColdSession, requirePlayable, secondsUntilUtcMidnight, formatCountdown } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  const moduleId = mod.moduleId;
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  getConfig(mod);
  const puzzle = await getPuzzleToday(gameServerId, moduleId);
  const wordle = await getWordleSession(gameServerId, moduleId, player.id);
  const hangman = await getHangmanSession(gameServerId, moduleId, player.id);
  const hotcold = await getHotColdSession(gameServerId, moduleId, player.id);
  await pog.pm([
    `🧩 Daily puzzles reset in ${formatCountdown(secondsUntilUtcMidnight())}`,
    `Wordle: ${puzzle.wordle ? (wordle.solved ? 'solved' : `${wordle.guesses.length}/6 guesses`) : 'not configured'}`,
    `Hangman: ${puzzle.hangman ? (hangman.solved ? 'solved' : `wrong ${hangman.wrongCount}/6`) : 'not configured'}`,
    `Hot/Cold: ${Number.isInteger(puzzle.hotcold) ? (hotcold.solved ? 'solved' : `${hotcold.guesses.length}/8 guesses`) : 'not ready'}`,
  ].join('\n'));
}

await main();
