import { takaro, TakaroUserError, checkPermission } from '@takaro/helpers';

export const CONTENT_WORDLE_KEY = 'minigames_content_wordle';
export const CONTENT_WORDLIST_KEY = 'minigames_content_wordlist';
export const CONTENT_TRIVIA_KEY = 'minigames_content_trivia';
export const PUZZLE_TODAY_KEY = 'minigames_puzzle_today';
export const ACTIVE_ROUND_KEY = 'minigames_active_round';
export const LAST_ROUND_KEY = 'minigames_last_round_fired_at';
export const LEADERBOARD_KEY = 'minigames_leaderboard_cache';
export const WARNINGS_KEY = 'minigames_admin_warned_empty_bank';
export const STATS_KEY = 'minigames_stats';
export const WINDOW_KEY = 'minigames_window';
export const BAN_KEY = 'minigames_ban';
export const WORDLE_SESSION_KEY = 'minigames_session_wordle';
export const HANGMAN_SESSION_KEY = 'minigames_session_hangman';
export const HOTCOLD_SESSION_KEY = 'minigames_session_hotcold';

export const REACTION_TOKENS = ['!first', '!go', '!grab', '!now', '!claim'];
export const OPENTDB_CATEGORIES = {
  general_knowledge: 9,
  books: 10,
  film: 11,
  music: 12,
  musicals_theatres: 13,
  television: 14,
  video_games: 15,
  board_games: 16,
  science_nature: 17,
  computers: 18,
  mathematics: 19,
  mythology: 20,
  sports: 21,
  geography: 22,
  history: 23,
  politics: 24,
  art: 25,
  celebrities: 26,
  animals: 27,
  vehicles: 28,
  comics: 29,
  gadgets: 30,
  anime_manga: 31,
  cartoon_animations: 32,
};

export const DEFAULT_STATS = {
  totalPoints: 0,
  gamesPlayed: 0,
  biggestScore: { points: 0, game: null, at: null },
  perGame: {
    wordle: { points: 0, plays: 0, wins: 0 },
    hangman: { points: 0, plays: 0, wins: 0 },
    hotcold: { points: 0, plays: 0, wins: 0 },
    trivia: { points: 0, plays: 0, wins: 0 },
    scramble: { points: 0, plays: 0, wins: 0 },
    mathrace: { points: 0, plays: 0, wins: 0 },
    reactionrace: { points: 0, plays: 0, wins: 0 },
  },
  streaks: {
    wordle: { current: 0, best: 0, lastSolvedDate: null },
  },
};

export function getConfig(mod) {
  const raw = mod?.userConfig || {};
  return {
    liveRoundIntervalMinutes: raw.liveRoundIntervalMinutes ?? 30,
    minPlayersForLiveRound: raw.minPlayersForLiveRound ?? 2,
    liveRoundAnswerWindowSec: raw.liveRoundAnswerWindowSec ?? 60,
    pointsToCurrencyRate: raw.pointsToCurrencyRate ?? 0,
    dailyPointsCapPerPlayer: raw.dailyPointsCapPerPlayer ?? 0,
    bigScoreThreshold: raw.bigScoreThreshold ?? 500,
    pointsWordleBase: raw.pointsWordleBase ?? 100,
    pointsHangmanBase: raw.pointsHangmanBase ?? 80,
    pointsHotColdBase: raw.pointsHotColdBase ?? 60,
    pointsTriviaWin: raw.pointsTriviaWin ?? 40,
    pointsScrambleWin: raw.pointsScrambleWin ?? 40,
    pointsMathRaceWin: raw.pointsMathRaceWin ?? 40,
    pointsReactionRaceWin: raw.pointsReactionRaceWin ?? 20,
    triviaQuestionSource: raw.triviaQuestionSource ?? 'api',
    triviaApiCategory: Array.isArray(raw.triviaApiCategory) && raw.triviaApiCategory.length > 0 ? raw.triviaApiCategory : ['any'],
    triviaApiDifficulty: raw.triviaApiDifficulty ?? 'any',
    triviaApiType: raw.triviaApiType ?? 'any',
    games: {
      wordle: raw.games?.wordle ?? true,
      hangman: raw.games?.hangman ?? true,
      hotcold: raw.games?.hotcold ?? true,
      trivia: raw.games?.trivia ?? true,
      scramble: raw.games?.scramble ?? true,
      mathrace: raw.games?.mathrace ?? true,
      reactionrace: raw.games?.reactionrace ?? true,
    },
  };
}

export function getTodayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9! ]+/g, '')
    .replace(/\s+/g, ' ');
}

export function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function findVariable(gameServerId, moduleId, key, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] || null;
}

export async function listVariablesByKey(gameServerId, moduleId, key) {
  const out = [];
  let page = 0;
  const limit = 100;
  let iterations = 0;
  while (true) {
    iterations += 1;
    if (iterations > 100) {
      console.error(`minigames: listVariablesByKey(${key}) exceeded pagination safety limit`);
      break;
    }
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] },
      page,
      limit,
    });
    const batch = res.data.data;
    out.push(...batch);
    if (batch.length < limit) break;
    page += 1;
  }
  return out;
}

export async function writeVariable(gameServerId, moduleId, key, value, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  const payload = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: payload });
    return existing.id;
  }
  const createData = { key, value: payload, gameServerId, moduleId };
  if (playerId) createData.playerId = playerId;
  const created = await takaro.variable.variableControllerCreate(createData);
  return created.data.data.id;
}

export async function deleteVariable(gameServerId, moduleId, key, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  if (existing) {
    await takaro.variable.variableControllerDelete(existing.id);
    return true;
  }
  return false;
}

export async function readJsonVariable(gameServerId, moduleId, key, fallback, playerId) {
  const variable = await findVariable(gameServerId, moduleId, key, playerId);
  if (!variable) return clone(fallback);
  try {
    return JSON.parse(variable.value);
  } catch (err) {
    console.error(`minigames: failed to parse ${key} (${playerId || 'global'}), using fallback. Error: ${err}`);
    return clone(fallback);
  }
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function ensureContentVariable(gameServerId, moduleId, key, fallback) {
  const variable = await findVariable(gameServerId, moduleId, key);
  if (!variable) {
    await writeVariable(gameServerId, moduleId, key, fallback);
    return clone(fallback);
  }
  try {
    return JSON.parse(variable.value);
  } catch (err) {
    console.error(`minigames: content variable ${key} was invalid JSON, resetting. Error: ${err}`);
    await writeVariable(gameServerId, moduleId, key, fallback);
    return clone(fallback);
  }
}

export function requirePermissionOrThrow(pog, permission, message) {
  if (!checkPermission(pog, permission)) {
    throw new TakaroUserError(message);
  }
}

export async function getBanRecord(gameServerId, moduleId, playerId) {
  const record = await readJsonVariable(gameServerId, moduleId, BAN_KEY, null, playerId);
  if (!record) return null;
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    await deleteVariable(gameServerId, moduleId, BAN_KEY, playerId);
    return null;
  }
  return record;
}

export async function requirePlayable({ gameServerId, moduleId, pog, playerId }) {
  requirePermissionOrThrow(pog, 'MINIGAMES_PLAY', 'You do not have permission to play mini-games.');
  if (checkPermission(pog, 'MINIGAMES_BANNED')) {
    throw new TakaroUserError('You are banned from mini-games.');
  }
  const ban = await getBanRecord(gameServerId, moduleId, playerId);
  if (ban) {
    const until = ban.expiresAt ? ` until ${ban.expiresAt}` : '';
    throw new TakaroUserError(`You are banned from mini-games${until}.`);
  }
}

export async function getDailyWindow(gameServerId, moduleId, playerId) {
  const today = getTodayUtcDate();
  const fallback = { date: today, earned: 0 };
  const window = await readJsonVariable(gameServerId, moduleId, WINDOW_KEY, fallback, playerId);
  if (window.date !== today) return fallback;
  return { date: today, earned: Number(window.earned) || 0 };
}

export async function checkCap(gameServerId, moduleId, playerId, config) {
  const cap = Number(config.dailyPointsCapPerPlayer) || 0;
  const window = await getDailyWindow(gameServerId, moduleId, playerId);
  if (cap <= 0) return { remainingToday: Infinity, window };
  const remainingToday = cap - window.earned;
  if (remainingToday <= 0) {
    throw new TakaroUserError("You've hit today's point cap — try again after UTC midnight.");
  }
  return { remainingToday, window };
}

export async function getPlayerStats(gameServerId, moduleId, playerId) {
  const stats = await readJsonVariable(gameServerId, moduleId, STATS_KEY, DEFAULT_STATS, playerId);
  return mergeStats(stats);
}

export function mergeStats(stats) {
  const merged = { ...clone(DEFAULT_STATS), ...(stats || {}) };
  merged.biggestScore = { ...DEFAULT_STATS.biggestScore, ...(stats?.biggestScore || {}) };
  merged.streaks = {
    wordle: { ...DEFAULT_STATS.streaks.wordle, ...(stats?.streaks?.wordle || {}) },
  };
  merged.perGame = { ...clone(DEFAULT_STATS.perGame), ...(stats?.perGame || {}) };
  for (const game of Object.keys(DEFAULT_STATS.perGame)) {
    merged.perGame[game] = { ...DEFAULT_STATS.perGame[game], ...(stats?.perGame?.[game] || {}) };
  }
  merged.totalPoints = Number(merged.totalPoints) || 0;
  merged.gamesPlayed = Number(merged.gamesPlayed) || 0;
  return merged;
}

export async function setPlayerStats(gameServerId, moduleId, playerId, stats) {
  await writeVariable(gameServerId, moduleId, STATS_KEY, stats, playerId);
}

export function getBoostMultiplier(pog) {
  const permission = checkPermission(pog, 'MINIGAMES_BOOST');
  const tier = permission && Number(permission.count) > 0 ? Math.min(Number(permission.count), 4) : 0;
  return 1 + (tier * 0.25);
}

export async function awardPoints({ gameServerId, moduleId, pog, playerId, playerName, config, game, basePoints, context }) {
  const { remainingToday, window } = await checkCap(gameServerId, moduleId, playerId, config);
  const multiplier = getBoostMultiplier(pog);
  const boostedPoints = Math.round(basePoints * multiplier);
  const actualPoints = remainingToday === Infinity ? boostedPoints : Math.max(0, Math.min(boostedPoints, remainingToday));

  const nextWindow = { date: window.date, earned: window.earned + actualPoints };
  await writeVariable(gameServerId, moduleId, WINDOW_KEY, nextWindow, playerId);

  const stats = await getPlayerStats(gameServerId, moduleId, playerId);
  stats.gamesPlayed += 1;
  stats.totalPoints += actualPoints;
  stats.perGame[game].plays += 1;
  stats.perGame[game].wins += 1;
  stats.perGame[game].points += actualPoints;
  if (actualPoints >= (stats.biggestScore?.points || 0)) {
    stats.biggestScore = { points: actualPoints, game, at: new Date().toISOString() };
  }
  await setPlayerStats(gameServerId, moduleId, playerId, stats);

  let currencyPaid = 0;
  const rate = Number(config.pointsToCurrencyRate) || 0;
  if (actualPoints > 0 && rate > 0) {
    currencyPaid = Math.round(actualPoints * rate);
    if (currencyPaid > 0) {
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
          currency: currencyPaid,
        });
      } catch (err) {
        console.error(`minigames: currency payout failed for player=${playerName} amount=${currencyPaid}. Continuing without currency. Error: ${err}`);
        currencyPaid = 0;
      }
    }
  }

  if (actualPoints >= (Number(config.bigScoreThreshold) || 500)) {
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `🏆 BIG SCORE! ${playerName} earned ${actualPoints} points in ${game}${context ? ` (${context})` : ''}.`,
        opts: {},
      });
    } catch (err) {
      console.error(`minigames: failed to broadcast big score for ${playerName}. Error: ${err}`);
    }
  }

  console.log(`minigames: award game=${game} player=${playerName} base=${basePoints} actual=${actualPoints} multiplier=${multiplier} currency=${currencyPaid}`);

  return {
    actualPoints,
    currencyPaid,
    newTotal: stats.totalPoints,
    multiplier,
  };
}

export function formatMultiplier(multiplier) {
  return multiplier > 1 ? ` (boost×${multiplier.toFixed(2)})` : '';
}

export async function getPuzzleToday(gameServerId, moduleId) {
  const today = getTodayUtcDate();
  const puzzle = await readJsonVariable(gameServerId, moduleId, PUZZLE_TODAY_KEY, { date: today }, null);
  if (puzzle.date !== today) return { date: today };
  return puzzle;
}

export async function getWordleBank(gameServerId, moduleId) {
  const content = await ensureContentVariable(gameServerId, moduleId, CONTENT_WORDLE_KEY, { words: [] });
  const words = Array.isArray(content.words)
    ? content.words.map((w) => String(w).trim().toLowerCase()).filter((w) => /^[a-z]{5}$/.test(w))
    : [];
  return words;
}

export async function getWordlistBank(gameServerId, moduleId) {
  const content = await ensureContentVariable(gameServerId, moduleId, CONTENT_WORDLIST_KEY, { words: [] });
  const words = Array.isArray(content.words)
    ? content.words.map((w) => String(w).trim().toLowerCase()).filter((w) => /^[a-z]{4,}$/.test(w))
    : [];
  return words;
}

export async function getTriviaBank(gameServerId, moduleId) {
  const content = await ensureContentVariable(gameServerId, moduleId, CONTENT_TRIVIA_KEY, { questions: [] });
  const questions = Array.isArray(content.questions) ? content.questions : [];
  return questions.map(normalizeTriviaQuestion).filter(Boolean);
}

export function normalizeTriviaQuestion(question) {
  if (!question || typeof question.question !== 'string') return null;
  if (Array.isArray(question.options) && Number.isInteger(question.answerIndex)) {
    const options = question.options.map((o) => String(o));
    const answer = options[question.answerIndex];
    if (!answer) return null;
    return {
      question: String(question.question),
      answer: String(answer),
      incorrectAnswers: options.filter((_, idx) => idx !== question.answerIndex),
      type: 'multiple',
    };
  }
  if (typeof question.answer === 'string') {
    return {
      question: String(question.question),
      answer: String(question.answer),
      incorrectAnswers: Array.isArray(question.incorrectAnswers) ? question.incorrectAnswers.map((a) => String(a)) : [],
      type: question.type === 'boolean' ? 'boolean' : (Array.isArray(question.incorrectAnswers) && question.incorrectAnswers.length > 0 ? 'multiple' : 'text'),
    };
  }
  return null;
}

export async function warnEmptyBanks(gameServerId, moduleId, keys) {
  if (keys.length === 0) return;
  const today = getTodayUtcDate();
  const warnings = await readJsonVariable(gameServerId, moduleId, WARNINGS_KEY, { date: today, keys: [] }, null);
  const effective = warnings.date === today ? warnings : { date: today, keys: [] };
  const freshKeys = keys.filter((key) => !effective.keys.includes(key));
  if (freshKeys.length === 0) return;
  effective.keys.push(...freshKeys);
  await writeVariable(gameServerId, moduleId, WARNINGS_KEY, effective);
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `⚠️ miniGames needs content in variable(s): ${freshKeys.join(', ')}`,
    opts: {},
  });
}

export async function rolloverDailyPuzzles(gameServerId, moduleId) {
  const wordleWords = await getWordleBank(gameServerId, moduleId);
  const wordlist = await getWordlistBank(gameServerId, moduleId);
  const emptyKeys = [];
  const today = getTodayUtcDate();
  const nextPuzzle = { date: today };

  if (wordleWords.length > 0) nextPuzzle.wordle = pickRandom(wordleWords);
  else emptyKeys.push(CONTENT_WORDLE_KEY);

  if (wordlist.length > 0) nextPuzzle.hangman = pickRandom(wordlist);
  else emptyKeys.push(CONTENT_WORDLIST_KEY);

  nextPuzzle.hotcold = 1 + Math.floor(Math.random() * 1000);

  await writeVariable(gameServerId, moduleId, PUZZLE_TODAY_KEY, nextPuzzle);
  await clearAllPlayerVariablesByKey(gameServerId, moduleId, WORDLE_SESSION_KEY);
  await clearAllPlayerVariablesByKey(gameServerId, moduleId, HANGMAN_SESSION_KEY);
  await clearAllPlayerVariablesByKey(gameServerId, moduleId, HOTCOLD_SESSION_KEY);
  await warnEmptyBanks(gameServerId, moduleId, emptyKeys);
  console.log(`minigames: rolloverDailyPuzzles completed wordle=${Boolean(nextPuzzle.wordle)} hangman=${Boolean(nextPuzzle.hangman)} hotcold=${nextPuzzle.hotcold}`);
  return nextPuzzle;
}

export async function clearAllPlayerVariablesByKey(gameServerId, moduleId, key) {
  const variables = await listVariablesByKey(gameServerId, moduleId, key);
  await Promise.allSettled(variables.map((v) => takaro.variable.variableControllerDelete(v.id)));
}

export function renderWordleFeedback(guess, answer) {
  const answerChars = answer.split('');
  const guessChars = guess.split('');
  const markers = new Array(guess.length).fill('⬜');
  const used = new Array(answer.length).fill(false);

  for (let i = 0; i < guessChars.length; i++) {
    if (guessChars[i] === answerChars[i]) {
      markers[i] = '🟩';
      used[i] = true;
    }
  }

  for (let i = 0; i < guessChars.length; i++) {
    if (markers[i] === '🟩') continue;
    const idx = answerChars.findIndex((char, answerIdx) => !used[answerIdx] && char === guessChars[i]);
    if (idx !== -1) {
      markers[i] = '🟨';
      used[idx] = true;
    }
  }

  return markers.join('');
}

export async function getWordleSession(gameServerId, moduleId, playerId) {
  return readJsonVariable(gameServerId, moduleId, WORDLE_SESSION_KEY, { guesses: [], solved: false, completedAt: null, lastPoints: 0 }, playerId);
}

export async function playWordle({ gameServerId, moduleId, player, pog, config, guess }) {
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  const puzzle = await getPuzzleToday(gameServerId, moduleId);
  if (!puzzle.wordle) throw new TakaroUserError('🟩 Wordle is not configured yet. Ask an admin to seed minigames_content_wordle.');

  const bank = await getWordleBank(gameServerId, moduleId);
  const session = await getWordleSession(gameServerId, moduleId, player.id);

  if (!guess) {
    const rendered = session.guesses.length > 0
      ? session.guesses.map((entry) => `${entry.toUpperCase()} ${renderWordleFeedback(entry, puzzle.wordle)}`).join(' | ')
      : 'No guesses yet.';
    const line = session.solved
      ? `🟩 Solved today in ${session.guesses.length}/6 for ${session.lastPoints} points.`
      : `🟩 ${session.guesses.length}/6 guesses used. ${rendered}`;
    await pog.pm(line);
    console.log(`wordle: status player=${player.name} guesses=${session.guesses.length} solved=${session.solved}`);
    return;
  }

  const normalized = String(guess).trim().toLowerCase();
  if (!/^[a-z]{5}$/.test(normalized)) throw new TakaroUserError('Wordle guesses must be exactly 5 letters.');
  if (!bank.includes(normalized)) throw new TakaroUserError('That word is not in the Wordle bank.');
  if (session.solved || session.completedAt) throw new TakaroUserError('You already finished today\'s Wordle.');
  if (session.guesses.length >= 6) throw new TakaroUserError('You already used all 6 Wordle guesses today.');
  if (session.guesses.includes(normalized)) throw new TakaroUserError('You already guessed that word.');

  session.guesses.push(normalized);
  const feedback = renderWordleFeedback(normalized, puzzle.wordle);

  if (normalized === puzzle.wordle) {
    session.solved = true;
    session.completedAt = new Date().toISOString();
    const basePoints = Math.round(Number(config.pointsWordleBase) * ((7 - session.guesses.length) / 6));
    const reward = await awardPoints({
      gameServerId,
      moduleId,
      pog,
      playerId: player.id,
      playerName: player.name,
      config,
      game: 'wordle',
      basePoints,
      context: `solved in ${session.guesses.length}`,
    });
    session.lastPoints = reward.actualPoints;

    const stats = await getPlayerStats(gameServerId, moduleId, player.id);
    const streak = stats.streaks.wordle || { current: 0, best: 0, lastSolvedDate: null };
    if (streak.lastSolvedDate === getTodayUtcDate()) {
      // already updated today — leave as-is
    } else {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayDate = yesterday.toISOString().slice(0, 10);
      const nextCurrent = streak.lastSolvedDate === yesterdayDate ? streak.current + 1 : 1;
      stats.streaks.wordle = {
        current: nextCurrent,
        best: Math.max(streak.best || 0, nextCurrent),
        lastSolvedDate: getTodayUtcDate(),
      };
      await setPlayerStats(gameServerId, moduleId, player.id, stats);
    }

    await writeVariable(gameServerId, moduleId, WORDLE_SESSION_KEY, session, player.id);
    await pog.pm(`🟩 ${feedback} SOLVED in ${session.guesses.length}! +${reward.actualPoints} points${formatMultiplier(reward.multiplier)}.`);
    console.log(`wordle: solved player=${player.name} guesses=${session.guesses.length} answer=${puzzle.wordle} points=${reward.actualPoints}`);
    return;
  }

  if (session.guesses.length >= 6) {
    session.completedAt = new Date().toISOString();
    const stats = await getPlayerStats(gameServerId, moduleId, player.id);
    stats.gamesPlayed += 1;
    stats.perGame.wordle.plays += 1;
    stats.streaks.wordle = {
      current: 0,
      best: stats.streaks.wordle.best || 0,
      lastSolvedDate: stats.streaks.wordle.lastSolvedDate || null,
    };
    await setPlayerStats(gameServerId, moduleId, player.id, stats);
    await writeVariable(gameServerId, moduleId, WORDLE_SESSION_KEY, session, player.id);
    await pog.pm(`🟩 ${feedback} Out of guesses — today's word was ${puzzle.wordle.toUpperCase()}.`);
    console.log(`wordle: failed player=${player.name} answer=${puzzle.wordle}`);
    return;
  }

  await writeVariable(gameServerId, moduleId, WORDLE_SESSION_KEY, session, player.id);
  await pog.pm(`🟩 ${feedback} (${6 - session.guesses.length}/6 left)`);
  console.log(`wordle: guess player=${player.name} guess=${normalized} feedback=${feedback}`);
}

export async function getHangmanSession(gameServerId, moduleId, playerId) {
  return readJsonVariable(gameServerId, moduleId, HANGMAN_SESSION_KEY, { lettersTried: [], wrongCount: 0, solved: false, completedAt: null, lastPoints: 0 }, playerId);
}

export function maskHangman(answer, lettersTried) {
  return answer
    .split('')
    .map((char) => (lettersTried.includes(char) ? char.toUpperCase() : '_'))
    .join(' ');
}

export async function playHangman({ gameServerId, moduleId, player, pog, config, letterOrWord }) {
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  const puzzle = await getPuzzleToday(gameServerId, moduleId);
  if (!puzzle.hangman) throw new TakaroUserError('🎪 Hangman is not configured yet. Ask an admin to seed minigames_content_wordlist.');

  const session = await getHangmanSession(gameServerId, moduleId, player.id);
  if (!letterOrWord) {
    await pog.pm(`🎪 ${maskHangman(puzzle.hangman, session.lettersTried)} (wrong ${session.wrongCount}/6, tried: ${session.lettersTried.join(', ').toUpperCase() || 'none'})`);
    console.log(`hangman: status player=${player.name} wrong=${session.wrongCount}`);
    return;
  }

  if (session.solved || session.completedAt) throw new TakaroUserError('You already finished today\'s Hangman.');

  const attempt = String(letterOrWord).trim().toLowerCase();
  if (!/^[a-z]+$/.test(attempt)) throw new TakaroUserError('Hangman guesses must use letters only.');

  if (attempt.length === 1) {
    if (session.lettersTried.includes(attempt)) throw new TakaroUserError('You already tried that letter.');
    session.lettersTried.push(attempt);
    if (!puzzle.hangman.includes(attempt)) session.wrongCount += 1;
  } else if (attempt === puzzle.hangman) {
    for (const char of puzzle.hangman.split('')) {
      if (!session.lettersTried.includes(char)) session.lettersTried.push(char);
    }
    session.solved = true;
  } else {
    session.wrongCount = 6;
    session.completedAt = new Date().toISOString();
  }

  const solved = session.solved || puzzle.hangman.split('').every((char) => session.lettersTried.includes(char));
  if (solved) {
    session.solved = true;
    session.completedAt = new Date().toISOString();
    const basePoints = Math.round(Number(config.pointsHangmanBase) * ((7 - session.wrongCount) / 7));
    const reward = await awardPoints({
      gameServerId,
      moduleId,
      pog,
      playerId: player.id,
      playerName: player.name,
      config,
      game: 'hangman',
      basePoints,
      context: `wrong=${session.wrongCount}`,
    });
    session.lastPoints = reward.actualPoints;
    await writeVariable(gameServerId, moduleId, HANGMAN_SESSION_KEY, session, player.id);
    await pog.pm(`🎪 ${maskHangman(puzzle.hangman, session.lettersTried)} SOLVED! +${reward.actualPoints} points${formatMultiplier(reward.multiplier)}.`);
    console.log(`hangman: solved player=${player.name} answer=${puzzle.hangman} wrong=${session.wrongCount}`);
    return;
  }

  if (session.wrongCount >= 6) {
    session.completedAt = new Date().toISOString();
    const stats = await getPlayerStats(gameServerId, moduleId, player.id);
    stats.gamesPlayed += 1;
    stats.perGame.hangman.plays += 1;
    await setPlayerStats(gameServerId, moduleId, player.id, stats);
    await writeVariable(gameServerId, moduleId, HANGMAN_SESSION_KEY, session, player.id);
    await pog.pm(`🎪 Game over — the word was ${puzzle.hangman.toUpperCase()}.`);
    console.log(`hangman: failed player=${player.name} answer=${puzzle.hangman}`);
    return;
  }

  await writeVariable(gameServerId, moduleId, HANGMAN_SESSION_KEY, session, player.id);
  await pog.pm(`🎪 ${maskHangman(puzzle.hangman, session.lettersTried)} (wrong ${session.wrongCount}/6)`);
  console.log(`hangman: guess player=${player.name} attempt=${attempt} wrong=${session.wrongCount}`);
}

export async function getHotColdSession(gameServerId, moduleId, playerId) {
  return readJsonVariable(gameServerId, moduleId, HOTCOLD_SESSION_KEY, { guesses: [], solved: false, completedAt: null, lastPoints: 0 }, playerId);
}

export function describeHotCold(secret, previous, current) {
  if (current === secret) return 'Solved';
  const direction = current < secret ? 'Higher' : 'Lower';
  if (previous == null) return `${direction}. Baseline.`;
  const prevDistance = Math.abs(secret - previous);
  const currentDistance = Math.abs(secret - current);
  let warmth = 'Same';
  if (currentDistance < prevDistance) warmth = 'Warmer';
  if (currentDistance > prevDistance) warmth = 'Colder';
  return `${direction}. ${warmth}.`;
}

export async function playHotCold({ gameServerId, moduleId, player, pog, config, number }) {
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  const puzzle = await getPuzzleToday(gameServerId, moduleId);
  if (!Number.isInteger(puzzle.hotcold)) throw new TakaroUserError('🌡️ Hot/Cold is not ready yet.');

  const session = await getHotColdSession(gameServerId, moduleId, player.id);
  if (number === undefined || number === null || number === '') {
    const trail = session.guesses.length > 0 ? session.guesses.join(', ') : 'No guesses yet.';
    await pog.pm(`🌡️ ${trail} (${8 - session.guesses.length}/8 left)`);
    console.log(`hotcold: status player=${player.name} guesses=${session.guesses.length}`);
    return;
  }

  if (session.solved || session.completedAt) throw new TakaroUserError('You already finished today\'s Hot/Cold puzzle.');
  const guess = Number(number);
  if (!Number.isInteger(guess) || guess < 1 || guess > 1000) throw new TakaroUserError('Hot/Cold guesses must be an integer from 1 to 1000.');

  const previous = session.guesses.length > 0 ? session.guesses[session.guesses.length - 1] : null;
  session.guesses.push(guess);
  const description = describeHotCold(puzzle.hotcold, previous, guess);

  if (guess === puzzle.hotcold) {
    session.solved = true;
    session.completedAt = new Date().toISOString();
    const basePoints = Math.round(Number(config.pointsHotColdBase) * ((9 - session.guesses.length) / 8));
    const reward = await awardPoints({
      gameServerId,
      moduleId,
      pog,
      playerId: player.id,
      playerName: player.name,
      config,
      game: 'hotcold',
      basePoints,
      context: `solved in ${session.guesses.length}`,
    });
    session.lastPoints = reward.actualPoints;
    await writeVariable(gameServerId, moduleId, HOTCOLD_SESSION_KEY, session, player.id);
    await pog.pm(`🌡️ SOLVED in ${session.guesses.length}! +${reward.actualPoints} points${formatMultiplier(reward.multiplier)}.`);
    console.log(`hotcold: solved player=${player.name} secret=${puzzle.hotcold} guesses=${session.guesses.length}`);
    return;
  }

  if (session.guesses.length >= 8) {
    session.completedAt = new Date().toISOString();
    const stats = await getPlayerStats(gameServerId, moduleId, player.id);
    stats.gamesPlayed += 1;
    stats.perGame.hotcold.plays += 1;
    await setPlayerStats(gameServerId, moduleId, player.id, stats);
    await writeVariable(gameServerId, moduleId, HOTCOLD_SESSION_KEY, session, player.id);
    await pog.pm(`🌡️ ${description} Out of guesses — the number was ${puzzle.hotcold}.`);
    console.log(`hotcold: failed player=${player.name} secret=${puzzle.hotcold}`);
    return;
  }

  await writeVariable(gameServerId, moduleId, HOTCOLD_SESSION_KEY, session, player.id);
  await pog.pm(`🌡️ ${description} (${8 - session.guesses.length}/8 left)`);
  console.log(`hotcold: guess player=${player.name} guess=${guess} description=${description}`);
}

export async function getActiveRound(gameServerId, moduleId) {
  const round = await readJsonVariable(gameServerId, moduleId, ACTIVE_ROUND_KEY, null, null);
  if (!round) return null;
  if (!round.expiresAt || !round.game) return null;
  return round;
}

export async function setActiveRound(gameServerId, moduleId, round) {
  await writeVariable(gameServerId, moduleId, ACTIVE_ROUND_KEY, round);
}

export async function clearActiveRound(gameServerId, moduleId) {
  await deleteVariable(gameServerId, moduleId, ACTIVE_ROUND_KEY, null);
}

export async function getOnlinePlayers(gameServerId) {
  const all = [];
  let page = 0;
  const limit = 100;
  while (true) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      page,
      limit,
    });
    const batch = res.data.data;
    all.push(...batch);
    if (batch.length < limit) break;
    page += 1;
  }
  return all;
}

export async function fetchTriviaQuestion(config) {
  if (config.triviaQuestionSource !== 'api') return null;
  const categories = Array.isArray(config.triviaApiCategory) ? config.triviaApiCategory.filter(Boolean) : [];
  const pickedCategory = categories.length > 0 ? pickRandom(categories) : 'any';
  let url = 'https://opentdb.com/api.php?amount=1';
  if (pickedCategory && pickedCategory !== 'any' && OPENTDB_CATEGORIES[pickedCategory]) {
    url += `&category=${OPENTDB_CATEGORIES[pickedCategory]}`;
  }
  if (config.triviaApiDifficulty && config.triviaApiDifficulty !== 'any') {
    url += `&difficulty=${config.triviaApiDifficulty}`;
  }
  if (config.triviaApiType && config.triviaApiType !== 'any') {
    url += `&type=${config.triviaApiType}`;
  }

  try {
    let response;
    if (takaro.axios?.get) {
      response = await takaro.axios.get(url);
      response = response.data;
    } else if (typeof fetch === 'function') {
      const res = await fetch(url);
      response = await res.json();
    } else {
      console.log('minigames: trivia api unavailable (no takaro.axios or fetch)');
      return null;
    }

    if (!response || response.response_code !== 0 || !Array.isArray(response.results) || response.results.length === 0) {
      console.log(`minigames: trivia api returned unusable payload ${JSON.stringify(response)}`);
      return null;
    }

    const entry = response.results[0];
    return {
      question: decodeHtmlEntities(entry.question),
      answer: decodeHtmlEntities(entry.correct_answer),
      incorrectAnswers: Array.isArray(entry.incorrect_answers) ? entry.incorrect_answers.map((a) => decodeHtmlEntities(a)) : [],
      type: entry.type || 'multiple',
      source: 'api',
    };
  } catch (err) {
    console.log(`minigames: trivia api fetch failed, using fallback. Error: ${err}`);
    return null;
  }
}

export function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&eacute;/g, 'é')
    .replace(/&uuml;/g, 'ü')
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function scrambleWord(word) {
  let scrambled = word;
  let tries = 0;
  while (scrambled === word && tries < 5) {
    scrambled = shuffle(word.split('')).join('');
    tries += 1;
  }
  return scrambled;
}

export function buildMathRound() {
  const operations = ['+', '-', '*', '/'];
  for (let i = 0; i < 50; i++) {
    const operandCount = Math.random() < 0.5 ? 2 : 3;
    const values = [2 + Math.floor(Math.random() * 29), 2 + Math.floor(Math.random() * 29), 2 + Math.floor(Math.random() * 29)];
    const ops = [pickRandom(operations), pickRandom(operations)];
    let expression = `${values[0]}`;
    let current = values[0];
    let valid = true;
    for (let idx = 1; idx < operandCount; idx++) {
      let value = values[idx];
      const op = ops[idx - 1];
      if (op === '/') {
        value = 2 + Math.floor(Math.random() * 10);
        current = current * value;
        expression += ` ÷ ${value}`;
        current = current / value;
      } else if (op === '*') {
        expression += ` × ${value}`;
        current *= value;
      } else if (op === '+') {
        expression += ` + ${value}`;
        current += value;
      } else {
        expression += ` - ${value}`;
        current -= value;
      }
      if (!Number.isInteger(current)) valid = false;
    }
    if (valid && current >= -500 && current <= 10000) {
      return { prompt: `${expression} = ?`, answer: current };
    }
  }
  return { prompt: '17 + 25 = ?', answer: 42 };
}

export async function createLiveRound({ gameServerId, moduleId, config, forcedGame }) {
  const enabledGames = ['trivia', 'scramble', 'mathrace', 'reactionrace'].filter((game) => config.games[game]);
  if (enabledGames.length === 0) return null;

  const game = forcedGame || pickRandom(enabledGames);
  const expiresAt = new Date(Date.now() + (Number(config.liveRoundAnswerWindowSec) || 60) * 1000).toISOString();

  if (game === 'scramble') {
    const wordlist = (await getWordlistBank(gameServerId, moduleId)).filter((word) => word.length >= 4);
    if (wordlist.length === 0) {
      await warnEmptyBanks(gameServerId, moduleId, [CONTENT_WORDLIST_KEY]);
      return null;
    }
    const answer = pickRandom(wordlist);
    return {
      game,
      prompt: scrambleWord(answer).toUpperCase(),
      answer,
      answerType: 'text',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt,
    };
  }

  if (game === 'mathrace') {
    const math = buildMathRound();
    return {
      game,
      prompt: math.prompt,
      answer: String(math.answer),
      answerType: 'number',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt,
    };
  }

  if (game === 'reactionrace') {
    const token = pickRandom(REACTION_TOKENS);
    return {
      game,
      prompt: token,
      answer: token,
      answerType: 'rawchat',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt,
    };
  }

  if (game === 'trivia') {
    const fromApi = await fetchTriviaQuestion(config);
    const picked = fromApi || pickRandom(await getTriviaBank(gameServerId, moduleId));
    if (!picked) {
      await warnEmptyBanks(gameServerId, moduleId, [CONTENT_TRIVIA_KEY]);
      return null;
    }
    const options = picked.type === 'multiple' || picked.type === 'boolean'
      ? shuffle([picked.answer, ...(picked.incorrectAnswers || [])])
      : [];
    return {
      game,
      prompt: picked.question,
      answer: picked.answer,
      answerType: 'text',
      displayedOptions: options,
      startedAt: new Date().toISOString(),
      expiresAt,
    };
  }

  return null;
}

export async function announceRound(gameServerId, round, config) {
  let message = '';
  if (round.game === 'trivia') {
    message = `❓ TRIVIA: ${round.prompt}`;
    if (Array.isArray(round.displayedOptions) && round.displayedOptions.length > 0) {
      message += ` Options: ${round.displayedOptions.join(', ')}`;
    }
    message += ` — /answer <your guess> (${config.liveRoundAnswerWindowSec}s)`;
  } else if (round.game === 'scramble') {
    message = `🔤 SCRAMBLE: ${round.prompt} — /answer <word> (${config.liveRoundAnswerWindowSec}s)`;
  } else if (round.game === 'mathrace') {
    message = `➗ MATH: ${round.prompt} — /answer <number> (${config.liveRoundAnswerWindowSec}s)`;
  } else if (round.game === 'reactionrace') {
    message = `⚡ REACTION: first to type ${round.prompt} wins! (${config.liveRoundAnswerWindowSec}s)`;
  }
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: {} });
}

export async function maybeFireLiveRound({ gameServerId, moduleId, config, forcedGame, ignoreThresholds = false }) {
  const active = await getActiveRound(gameServerId, moduleId);
  if (active) {
    console.log(`minigames: fire skipped because round ${active.game} is already active`);
    return null;
  }

  if (!ignoreThresholds) {
    const lastFired = await readJsonVariable(gameServerId, moduleId, LAST_ROUND_KEY, { firedAt: null }, null);
    if (lastFired.firedAt) {
      const elapsedMinutes = (Date.now() - new Date(lastFired.firedAt).getTime()) / 60000;
      if (elapsedMinutes < Number(config.liveRoundIntervalMinutes || 30)) {
        console.log(`minigames: fire skipped due to interval elapsed=${elapsedMinutes.toFixed(2)} required=${config.liveRoundIntervalMinutes}`);
        return null;
      }
    }

    const onlinePlayers = await getOnlinePlayers(gameServerId);
    if (onlinePlayers.length < Number(config.minPlayersForLiveRound || 2)) {
      console.log(`minigames: fire skipped due to onlinePlayers=${onlinePlayers.length}`);
      return null;
    }
  }

  const round = await createLiveRound({ gameServerId, moduleId, config, forcedGame });
  if (!round) return null;

  await setActiveRound(gameServerId, moduleId, round);
  await writeVariable(gameServerId, moduleId, LAST_ROUND_KEY, { firedAt: new Date().toISOString(), game: round.game });
  await announceRound(gameServerId, round, config);
  console.log(`minigames: live round fired game=${round.game} answer=${round.answer}`);
  return round;
}

export async function closeExpiredRound({ gameServerId, moduleId, reason = 'expired' }) {
  const round = await getActiveRound(gameServerId, moduleId);
  if (!round) return null;
  if (reason === 'expired' && new Date(round.expiresAt).getTime() > Date.now()) {
    return null;
  }
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `⌛ ${round.game.toUpperCase()} closed — nobody got it. Answer: ${round.answer}`,
    opts: {},
  });
  await clearActiveRound(gameServerId, moduleId);
  console.log(`minigames: live round closed game=${round.game} reason=${reason}`);
  return round;
}

export function getLiveRoundPoints(config, game) {
  if (game === 'trivia') return Number(config.pointsTriviaWin) || 40;
  if (game === 'scramble') return Number(config.pointsScrambleWin) || 40;
  if (game === 'mathrace') return Number(config.pointsMathRaceWin) || 40;
  if (game === 'reactionrace') return Number(config.pointsReactionRaceWin) || 20;
  return 0;
}

export async function settleLiveRound({ gameServerId, moduleId, player, pog, config, round, response, source = 'command' }) {
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  const normalizedResponse = normalizeText(response);
  const normalizedAnswer = normalizeText(round.answer);
  if (normalizedResponse !== normalizedAnswer) {
    console.log(`minigames: ${source} incorrect game=${round.game} player=${player.name} response=${response}`);
    return false;
  }

  const reward = await awardPoints({
    gameServerId,
    moduleId,
    pog,
    playerId: player.id,
    playerName: player.name,
    config,
    game: round.game,
    basePoints: getLiveRoundPoints(config, round.game),
    context: `${source} win`,
  });
  await clearActiveRound(gameServerId, moduleId);
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `${gameEmoji(round.game)} ${player.name} won ${round.game}! +${reward.actualPoints} points${formatMultiplier(reward.multiplier)}. Answer: ${round.answer}`,
    opts: {},
  });
  console.log(`minigames: live round settled game=${round.game} player=${player.name} source=${source} points=${reward.actualPoints}`);
  return true;
}

export function gameEmoji(game) {
  return ({ wordle: '🟩', hangman: '🎪', hotcold: '🌡️', trivia: '❓', scramble: '🔤', mathrace: '➗', reactionrace: '⚡' }[game]) || '🎮';
}

export async function handleAnswerCommand({ gameServerId, moduleId, player, pog, config, response }) {
  await requirePlayable({ gameServerId, moduleId, pog, playerId: player.id });
  if (!response || !String(response).trim()) throw new TakaroUserError('Usage: /answer <response>');
  const round = await getActiveRound(gameServerId, moduleId);
  if (!round) throw new TakaroUserError('There is no active live round right now.');
  if (round.game === 'reactionrace') throw new TakaroUserError('This round is chat-only — type the token directly in chat.');
  const success = await settleLiveRound({ gameServerId, moduleId, player, pog, config, round, response, source: 'command' });
  if (!success) {
    await pog.pm(`❌ Not correct for ${round.game}. Keep trying.`);
  }
}

export async function processReactionMessage({ gameServerId, moduleId, player, pog, config, message }) {
  const round = await getActiveRound(gameServerId, moduleId);
  if (!round || round.game !== 'reactionrace') return false;
  if (!player || !pog) return false;
  return settleLiveRound({ gameServerId, moduleId, player, pog, config, round, response: message, source: 'chat' });
}

export async function getAllStats(gameServerId, moduleId) {
  const variables = await listVariablesByKey(gameServerId, moduleId, STATS_KEY);
  const out = [];
  for (const variable of variables) {
    if (!variable.playerId) continue;
    try {
      out.push({ playerId: variable.playerId, stats: mergeStats(JSON.parse(variable.value)) });
    } catch (err) {
      console.error(`minigames: failed to parse stats for player ${variable.playerId}. Error: ${err}`);
    }
  }
  return out;
}

export async function getPlayerName(playerId) {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data?.name || playerId;
  } catch (err) {
    console.error(`minigames: failed to fetch player ${playerId}. Error: ${err}`);
    return playerId;
  }
}

export async function refreshLeaderboards(gameServerId, moduleId) {
  const allStats = await getAllStats(gameServerId, moduleId);
  const enriched = [];
  for (const entry of allStats) {
    enriched.push({ ...entry, name: await getPlayerName(entry.playerId) });
  }

  const topPoints = [...enriched]
    .sort((a, b) => b.stats.totalPoints - a.stats.totalPoints)
    .slice(0, 10)
    .map((entry) => ({ playerId: entry.playerId, name: entry.name, value: entry.stats.totalPoints }));

  const topWordle = [...enriched]
    .sort((a, b) => b.stats.perGame.wordle.wins - a.stats.perGame.wordle.wins)
    .slice(0, 10)
    .map((entry) => ({ playerId: entry.playerId, name: entry.name, value: entry.stats.perGame.wordle.wins }));

  const topHangman = [...enriched]
    .sort((a, b) => b.stats.perGame.hangman.wins - a.stats.perGame.hangman.wins)
    .slice(0, 10)
    .map((entry) => ({ playerId: entry.playerId, name: entry.name, value: entry.stats.perGame.hangman.wins }));

  const topStreak = [...enriched]
    .sort((a, b) => b.stats.streaks.wordle.best - a.stats.streaks.wordle.best)
    .slice(0, 10)
    .map((entry) => ({ playerId: entry.playerId, name: entry.name, value: entry.stats.streaks.wordle.best }));

  const cache = { topPoints, topWordle, topHangman, topStreak, refreshedAt: new Date().toISOString() };
  await writeVariable(gameServerId, moduleId, LEADERBOARD_KEY, cache);
  console.log(`minigames: refreshLeaderboards players=${enriched.length}`);
  return cache;
}

export async function getLeaderboardCache(gameServerId, moduleId) {
  return readJsonVariable(gameServerId, moduleId, LEADERBOARD_KEY, { topPoints: [], topWordle: [], topHangman: [], topStreak: [], refreshedAt: null }, null);
}

export function renderLeaderboard(title, entries) {
  if (!entries || entries.length === 0) return `${title}: no data yet.`;
  return [title, ...entries.map((entry, idx) => `${idx + 1}. ${entry.name} — ${entry.value}`)].join('\n');
}

export async function findPlayerByName(name) {
  const search = await takaro.player.playerControllerSearch({ search: { name: [name] } });
  return search.data.data.find((player) => player.name.toLowerCase() === String(name).toLowerCase()) || null;
}

export async function banPlayer({ gameServerId, moduleId, targetName, hours }) {
  const target = await findPlayerByName(targetName);
  if (!target) throw new TakaroUserError(`Player "${targetName}" not found.`);
  const record = {};
  if (hours !== undefined && hours !== null && hours !== '') {
    const duration = Number(hours);
    if (!Number.isFinite(duration) || duration <= 0) throw new TakaroUserError('Ban hours must be a positive number.');
    record.expiresAt = new Date(Date.now() + duration * 60 * 60 * 1000).toISOString();
  }
  await writeVariable(gameServerId, moduleId, BAN_KEY, record, target.id);
  console.log(`minigames: banned player=${target.name} expiresAt=${record.expiresAt || 'never'}`);
  return target;
}

export async function unbanPlayer({ gameServerId, moduleId, targetName }) {
  const target = await findPlayerByName(targetName);
  if (!target) throw new TakaroUserError(`Player "${targetName}" not found.`);
  const removed = await deleteVariable(gameServerId, moduleId, BAN_KEY, target.id);
  console.log(`minigames: unbanned player=${target.name} removed=${removed}`);
  return { target, removed };
}

export async function resetPlayerStats({ gameServerId, moduleId, targetName }) {
  const target = await findPlayerByName(targetName);
  if (!target) throw new TakaroUserError(`Player "${targetName}" not found.`);
  const removedStats = await deleteVariable(gameServerId, moduleId, STATS_KEY, target.id);
  await deleteVariable(gameServerId, moduleId, WINDOW_KEY, target.id);
  await deleteVariable(gameServerId, moduleId, WORDLE_SESSION_KEY, target.id);
  await deleteVariable(gameServerId, moduleId, HANGMAN_SESSION_KEY, target.id);
  await deleteVariable(gameServerId, moduleId, HOTCOLD_SESSION_KEY, target.id);
  console.log(`minigames: reset stats player=${target.name} removedStats=${removedStats}`);
  return { target, removedStats };
}

export async function expireWindows(gameServerId, moduleId) {
  const today = getTodayUtcDate();
  const variables = await listVariablesByKey(gameServerId, moduleId, WINDOW_KEY);
  let removed = 0;
  for (const variable of variables) {
    try {
      const value = JSON.parse(variable.value);
      if (value.date !== today) {
        await takaro.variable.variableControllerDelete(variable.id);
        removed += 1;
      }
    } catch (err) {
      console.error(`minigames: expireWindows deleting invalid window ${variable.id}. Error: ${err}`);
      await takaro.variable.variableControllerDelete(variable.id);
      removed += 1;
    }
  }
  console.log(`minigames: expireWindows removed=${removed}`);
  return removed;
}

export async function expireBans(gameServerId, moduleId) {
  const variables = await listVariablesByKey(gameServerId, moduleId, BAN_KEY);
  let removed = 0;
  for (const variable of variables) {
    try {
      const value = JSON.parse(variable.value);
      if (value.expiresAt && new Date(value.expiresAt).getTime() <= Date.now()) {
        await takaro.variable.variableControllerDelete(variable.id);
        removed += 1;
      }
    } catch (err) {
      console.error(`minigames: expireBans deleting invalid ban ${variable.id}. Error: ${err}`);
      await takaro.variable.variableControllerDelete(variable.id);
      removed += 1;
    }
  }
  console.log(`minigames: expireBans removed=${removed}`);
  return removed;
}

export async function buildReport(gameServerId, moduleId, days) {
  const allStats = await getAllStats(gameServerId, moduleId);
  const totalPoints = allStats.reduce((sum, entry) => sum + entry.stats.totalPoints, 0);
  const totalRounds = allStats.reduce((sum, entry) => sum + entry.stats.gamesPlayed, 0);
  const perGame = Object.keys(DEFAULT_STATS.perGame).map((game) => {
    const points = allStats.reduce((sum, entry) => sum + entry.stats.perGame[game].points, 0);
    const wins = allStats.reduce((sum, entry) => sum + entry.stats.perGame[game].wins, 0);
    return `${game}: ${points} pts / ${wins} wins`;
  });
  const top = [...allStats]
    .sort((a, b) => b.stats.totalPoints - a.stats.totalPoints)
    .slice(0, 5);
  const topLines = [];
  for (let i = 0; i < top.length; i++) {
    const name = await getPlayerName(top[i].playerId);
    topLines.push(`${i + 1}. ${name} — ${top[i].stats.totalPoints}`);
  }
  return [`miniGames report (${days}d window hint)`, `Rounds: ${totalRounds}`, `Points awarded: ${totalPoints}`, 'Top 5:', ...(topLines.length > 0 ? topLines : ['No data yet.']), 'Per-game:', ...perGame].join('\n');
}
