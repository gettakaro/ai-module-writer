import { data } from '@takaro/helpers';
import { getConfig, requirePlayable } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  const moduleId = mod.moduleId;
  const config = getConfig(mod);
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });

  const game = String(args.game || '').trim().toLowerCase();
  const lines = {
    wordle: '🟩 /wordle [guess] — 6 guesses to solve the daily 5-letter word.',
    hangman: '🎪 /hangman [letterOrWord] — reveal the daily word before 6 wrong guesses.',
    hotcold: '🌡️ /hotcold [number] — guess today\'s number from 1 to 1000.',
    trivia: '❓ Live round — use /answer <response> when trivia fires.',
    scramble: '🔤 Live round — use /answer <word> when a scramble fires.',
    mathrace: '➗ Live round — use /answer <number> when mathrace fires.',
    reactionrace: '⚡ Live round — type the token directly in chat.',
  };

  if (game) {
    await pog.pm(lines[game] || `Unknown game "${game}". Try: wordle, hangman, hotcold, trivia, scramble, mathrace, reactionrace.`);
    return;
  }

  await pog.pm([
    '🎮 miniGames',
    'Daily puzzles: /wordle, /hangman, /hotcold, /puzzle',
    'Live rounds: /answer, reaction-race in raw chat',
    'Stats: /minigamestats [player], /minigamestop <points|wordle|hangman|streak>',
    `Live round cadence: every ~${config.liveRoundIntervalMinutes} min when enough players are online.`,
  ].join('\n'));
}

await main();
