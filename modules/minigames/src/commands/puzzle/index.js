import { data } from '@takaro/helpers';
import { getConfig, getPuzzleToday, getWordleSession, getHangmanSession, getHotColdSession, requirePlayable, secondsUntilUtcMidnight, formatCountdown } from './minigames-helpers.js';

function describeWordle(config, puzzle, session) {
  if (!config.games.wordle) return 'disabled';
  if (!puzzle.wordle) return 'not configured';
  if (session.solved) return `completed (${session.guesses.length}/6 guesses)`;
  if (session.completedAt) return `failed (${session.guesses.length}/6 guesses)`;
  return `${session.guesses.length}/6 guesses`;
}

function describeHangman(config, puzzle, session) {
  if (!config.games.hangman) return 'disabled';
  if (!puzzle.hangman) return 'not configured';
  if (session.solved) return `completed (wrong ${session.wrongCount}/6)`;
  if (session.completedAt) return `failed (wrong ${session.wrongCount}/6)`;
  return `wrong ${session.wrongCount}/6`;
}

function describeHotCold(config, puzzle, session) {
  if (!config.games.hotcold) return 'disabled';
  if (!Number.isInteger(puzzle.hotcold)) return 'not ready';
  if (session.solved) return `completed (${session.guesses.length}/8 guesses)`;
  if (session.completedAt) return `failed (${session.guesses.length}/8 guesses)`;
  return `${session.guesses.length}/8 guesses`;
}

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  const moduleId = mod.moduleId;
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  const config = getConfig(mod);
  const puzzle = await getPuzzleToday(gameServerId, moduleId);
  const wordle = await getWordleSession(gameServerId, moduleId, player.id);
  const hangman = await getHangmanSession(gameServerId, moduleId, player.id);
  const hotcold = await getHotColdSession(gameServerId, moduleId, player.id);
  const message = [
    `🧩 Daily puzzles reset in ${formatCountdown(secondsUntilUtcMidnight())}`,
    `Wordle: ${describeWordle(config, puzzle, wordle)}`,
    `Hangman: ${describeHangman(config, puzzle, hangman)}`,
    `Hot/Cold: ${describeHotCold(config, puzzle, hotcold)}`,
  ].join('\n');
  await pog.pm(message);
  console.log(`minigames: puzzle status=${message.replace(/\n/g, ' | ')}`);
}

await main();
