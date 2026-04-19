import { data } from '@takaro/helpers';
import { getConfig, requirePlayable, normalizeOptionalStringArg } from './minigames-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  const moduleId = mod.moduleId;
  const config = getConfig(mod);
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });

  const game = normalizeOptionalStringArg(args.game).toLowerCase();
  const lines = {
    wordle: config.games.wordle ? '🟩 /wordle [guess] — 6 guesses to solve the daily 5-letter word.' : '🟩 Wordle is disabled on this server.',
    hangman: config.games.hangman ? '🎪 /hangman [letterOrWord] — reveal the daily word before 6 wrong guesses.' : '🎪 Hangman is disabled on this server.',
    hotcold: config.games.hotcold ? '🌡️ /hotcold [number] — guess today\'s number from 1 to 1000.' : '🌡️ Hot/Cold is disabled on this server.',
    trivia: config.games.trivia ? '❓ Live round — use /answer <response> when trivia fires.' : '❓ Trivia is disabled on this server.',
    scramble: config.games.scramble ? '🔤 Live round — use /answer <word> when a scramble fires.' : '🔤 Scramble is disabled on this server.',
    mathrace: config.games.mathrace ? '➗ Live round — use /answer <number> when mathrace fires.' : '➗ Math race is disabled on this server.',
    reactionrace: config.games.reactionrace ? '⚡ Live round — type the token directly in chat.' : '⚡ Reaction race is disabled on this server.',
  };

  if (game) {
    const message = lines[game] || `Unknown game "${game}". Try: wordle, hangman, hotcold, trivia, scramble, mathrace, reactionrace.`;
    await pog.pm(message);
    console.log(`minigames: help topic=${game} message=${message}`);
    return;
  }

  const enabledDaily = [config.games.wordle && '/wordle', config.games.hangman && '/hangman', config.games.hotcold && '/hotcold'].filter(Boolean);
  const enabledLive = [config.games.trivia && 'trivia', config.games.scramble && 'scramble', config.games.mathrace && 'mathrace', config.games.reactionrace && 'reaction-race'].filter(Boolean);
  const message = [
    '🎮 miniGames',
    `Daily puzzles: ${enabledDaily.length > 0 ? `${enabledDaily.join(', ')}, /puzzle` : '/puzzle (all daily puzzle games are disabled)'}`,
    `Live rounds: ${enabledLive.length > 0 ? `/answer, raw chat for reaction-race (${enabledLive.join(', ')})` : 'all live round games are disabled'}`,
    'Stats: /minigamestats [player], /minigamesleaderboard <points|wordle|hangman|streak> (legacy: /minigamestop)',
    `Live round cadence: every ~${config.liveRoundIntervalMinutes} min when enough players are online.`,
  ].join('\n');
  await pog.pm(message);
  console.log(`minigames: help overview=${message.replace(/\n/g, ' | ')}`);
}

await main();
