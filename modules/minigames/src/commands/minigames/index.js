import { data, checkPermission } from '@takaro/helpers';
import { getConfig, requirePlayable, normalizeOptionalStringArg } from './minigames-helpers.js';

function inferCommandPrefix(chatMessage, trigger) {
  const raw = String(chatMessage?.msg || chatMessage?.message || '').trim();
  if (!raw) return '/';
  const normalizedTrigger = String(trigger || 'minigames').trim();
  const triggerIndex = raw.toLowerCase().indexOf(normalizedTrigger.toLowerCase());
  if (triggerIndex <= 0) return '/';
  return raw.slice(0, triggerIndex);
}

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args, chatMessage } = data;
  const moduleId = mod.moduleId;
  const config = getConfig(mod);
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });

  const prefix = inferCommandPrefix(chatMessage, mod?.commands?.minigames?.trigger || 'minigames');
  const game = normalizeOptionalStringArg(args.game).toLowerCase();
  const lines = {
    wordle: config.games.wordle ? `🟩 ${prefix}wordle [guess] — 6 guesses to solve the daily 5-letter word.` : '🟩 Wordle is disabled on this server.',
    hangman: config.games.hangman ? `🎪 ${prefix}hangman [letterOrWord] — reveal the daily word before 6 wrong guesses.` : '🎪 Hangman is disabled on this server.',
    hotcold: config.games.hotcold ? `🌡️ ${prefix}hotcold [number] — guess today's number from 1 to 1000.` : '🌡️ Hot/Cold is disabled on this server.',
    trivia: config.games.trivia ? `❓ Live round — use ${prefix}answer <response> when trivia fires.` : '❓ Trivia is disabled on this server.',
    scramble: config.games.scramble ? `🔤 Live round — use ${prefix}answer <word> when a scramble fires.` : '🔤 Scramble is disabled on this server.',
    mathrace: config.games.mathrace ? `➗ Live round — use ${prefix}answer <number> when mathrace fires.` : '➗ Math race is disabled on this server.',
    reactionrace: config.games.reactionrace ? '⚡ Live round — type the token directly in chat.' : '⚡ Reaction race is disabled on this server.',
  };

  if (game) {
    const message = lines[game] || `Unknown game "${game}". Try: wordle, hangman, hotcold, trivia, scramble, mathrace, reactionrace.`;
    await pog.pm(message);
    console.log(`minigames: help topic=${game} message=${message}`);
    return;
  }

  const enabledDaily = [config.games.wordle && `${prefix}wordle`, config.games.hangman && `${prefix}hangman`, config.games.hotcold && `${prefix}hotcold`].filter(Boolean);
  const liveAnswerGames = [config.games.trivia && 'trivia', config.games.scramble && 'scramble', config.games.mathrace && 'math race'].filter(Boolean);
  const chatOnlyGames = [config.games.reactionrace && 'reaction race'].filter(Boolean);
  const liveSummary = [];
  if (liveAnswerGames.length > 0) liveSummary.push(`${prefix}answer for ${liveAnswerGames.join(', ')}`);
  if (chatOnlyGames.length > 0) liveSummary.push(`raw chat for ${chatOnlyGames.join(', ')}`);
  const isManager = Boolean(checkPermission(pog, 'MINIGAMES_MANAGE'));
  const message = [
    '🎮 miniGames',
    `Daily puzzles: ${enabledDaily.length > 0 ? `${enabledDaily.join(', ')}, ${prefix}puzzle` : `${prefix}puzzle (all daily puzzle games are disabled)`}`,
    `Live rounds: ${liveSummary.length > 0 ? liveSummary.join('; ') : 'all live round games are disabled'}`,
    `Stats: ${prefix}minigamestats [player], ${prefix}minigamestop <points|wordle|hangman|streak>`,
    ...(isManager ? [`Admin live-round control: ${prefix}minigamesskiproundnow stops the active round.`] : []),
    `Live round cadence: every ~${config.liveRoundIntervalMinutes} min when enough players are online.`,
  ].join('\n');
  await pog.pm(message);
  console.log(`minigames: help overview=${message.replace(/\n/g, ' | ')}`);
}

await main();
