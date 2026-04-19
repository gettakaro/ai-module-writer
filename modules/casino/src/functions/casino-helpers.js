import { takaro, TakaroUserError, checkPermission } from '@takaro/helpers';

export const KEY_STATS = 'casino_stats';
export const KEY_COOLDOWN = 'casino_cooldown';
export const KEY_BAN = 'casino_ban';
export const KEY_JACKPOT = 'casino_jackpot';
export const KEY_LEADERBOARD = 'casino_leaderboard_cache';
export const KEY_RACE_POOL = 'casino_race_pool';
export const KEY_DUEL = 'casino_duel';
export const KEY_HILO_SESSION = 'casino_session_hilo';
export const KEY_BLACKJACK_SESSION = 'casino_session_blackjack';
export const KEY_WINDOW_PREFIX = 'casino_window';
export const KEY_REPORT_DAY_PREFIX = 'casino_report_day';
export const KEY_LOCK_PREFIX = 'casino_lock';

export const DEFAULT_STATS = {
  wagered: 0,
  won: 0,
  net: 0,
  gamesPlayed: 0,
  wins: 0,
  biggestWin: {
    amount: 0,
    game: null,
    at: null,
  },
  perGame: {},
};

export function roundCurrency(value) {
  return Math.round(Number(value) || 0);
}

export function formatCurrency(value) {
  return `${roundCurrency(value)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep() {
  throw new Error('casino-helpers: sleep() is unavailable in the Takaro runtime');
}

export function formatUtcTimestamp(value) {
  if (!value) return 'unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.slice(0, 2).join(' ');
}

export function formatFutureTime(value) {
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return String(value);
  const diff = ts - Date.now();
  if (diff <= 0) return `now (${formatUtcTimestamp(value)})`;
  return `${formatDuration(diff)} (${formatUtcTimestamp(value)})`;
}

export function formatPastTime(value) {
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return String(value);
  const diff = Date.now() - ts;
  if (diff <= 0) return `just now (${formatUtcTimestamp(value)})`;
  return `${formatDuration(diff)} ago (${formatUtcTimestamp(value)})`;
}

export function getDefaultConfig(userConfig = {}) {
  return {
    minBet: Number(userConfig.minBet ?? 1),
    maxBet: Number(userConfig.maxBet ?? 1000),
    capWindow: userConfig.capWindow === 'weekly' ? 'weekly' : 'daily',
    wagerCap: Number(userConfig.wagerCap ?? 0),
    lossCap: Number(userConfig.lossCap ?? 0),
    houseEdgePct: Number(userConfig.houseEdgePct ?? 2),
    jackpotContributionPct: Number(userConfig.jackpotContributionPct ?? 1),
    cooldownSeconds: Number(userConfig.cooldownSeconds ?? 3),
    bigWinThreshold: Number(userConfig.bigWinThreshold ?? 1000),
    games: {
      flip: userConfig.games?.flip ?? true,
      dice: userConfig.games?.dice ?? true,
      hilo: userConfig.games?.hilo ?? true,
      roulette: userConfig.games?.roulette ?? true,
      slots: userConfig.games?.slots ?? true,
      blackjack: userConfig.games?.blackjack ?? true,
      crash: userConfig.games?.crash ?? true,
      duel: userConfig.games?.duel ?? true,
      race: userConfig.games?.race ?? true,
    },
  };
}

export function getGameEnabled(config, game) {
  const map = {
    flip: 'flip',
    dice: 'dice',
    hilo: 'hilo',
    roulette: 'roulette',
    slots: 'slots',
    blackjack: 'blackjack',
    crash: 'crash',
    duel: 'duel',
    race: 'race',
  };
  const key = map[game] ?? game;
  return config.games?.[key] ?? true;
}

export function getVipTier(pog) {
  const perm = checkPermission(pog, 'CASINO_VIP');
  const count = Number(perm?.count ?? 0);
  return Math.max(0, Math.min(4, Number.isFinite(count) ? count : 0));
}

export function getVipMultiplier(tier) {
  return 1 + (Math.max(0, tier) * 0.5);
}

export function getEffectiveEdgeFraction(config, vipTier) {
  const adjusted = Math.max(0, Number(config.houseEdgePct ?? 2) - (vipTier * 0.5));
  return adjusted / 100;
}

export function requirePlayPermission(pog) {
  if (!checkPermission(pog, 'CASINO_PLAY')) {
    throw new TakaroUserError('You do not have permission to play casino games.');
  }
  if (checkPermission(pog, 'CASINO_BANNED')) {
    throw new TakaroUserError('You are banned from the casino.');
  }
}

export function requireManagePermission(pog) {
  if (!checkPermission(pog, 'CASINO_MANAGE')) {
    throw new TakaroUserError('You do not have permission to manage the casino.');
  }
}

export function validateBetAmount(amount, config, vipTier) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || !Number.isInteger(numericAmount) || numericAmount < 1) {
    throw new TakaroUserError('Bet amount must be a positive whole number.');
  }
  if (numericAmount < config.minBet) {
    throw new TakaroUserError(`Minimum bet is ${formatCurrency(config.minBet)}.`);
  }
  const maxBet = Math.floor(config.maxBet * getVipMultiplier(vipTier));
  if (numericAmount > maxBet) {
    throw new TakaroUserError(`Your max bet is ${formatCurrency(maxBet)} with your current VIP tier.`);
  }
  return numericAmount;
}

export function getCurrentWindowKey(capWindow) {
  const now = new Date();
  if (capWindow === 'weekly') {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return now.toISOString().slice(0, 10);
}

export function getPreviousWindowKey(capWindow) {
  const now = new Date();
  if (capWindow === 'weekly') {
    now.setUTCDate(now.getUTCDate() - 7);
  } else {
    now.setUTCDate(now.getUTCDate() - 1);
  }
  if (capWindow === 'weekly') {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return now.toISOString().slice(0, 10);
}

export function getWindowKey(windowKey) {
  return `${KEY_WINDOW_PREFIX}:${windowKey}`;
}

export async function findVariable(gameServerId, moduleId, key, playerId) {
  const filters = {
    key: [key],
    gameServerId: [gameServerId],
    moduleId: [moduleId],
  };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

export async function searchVariables({ gameServerId, moduleId, key, playerId, page = 0, limit = 100, search }) {
  const filters = {
    gameServerId: [gameServerId],
    moduleId: [moduleId],
  };
  if (key) filters.key = Array.isArray(key) ? key : [key];
  if (playerId) filters.playerId = Array.isArray(playerId) ? playerId : [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters, page, limit, search });
  return res.data;
}

export async function writeVariable(gameServerId, moduleId, key, value, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    const payload = { key, value: serialized, gameServerId, moduleId };
    if (playerId) payload.playerId = playerId;
    await takaro.variable.variableControllerCreate(payload);
  }
}

export async function deleteVariable(gameServerId, moduleId, key, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  if (existing) {
    await takaro.variable.variableControllerDelete(existing.id);
  }
}

export function getLockKey(scope) {
  return `${KEY_LOCK_PREFIX}:${scope}`;
}

export async function acquireLock(gameServerId, moduleId, scope, { ttlMs = 15000, timeoutMs = 10000, retryMs = 100 } = {}) {
  const key = getLockKey(scope);
  const owner = `${nowIso()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.max(10, Math.ceil(timeoutMs / Math.max(1, retryMs)));
  let attempts = 0;

  while (Date.now() < deadline && attempts < maxAttempts) {
    attempts += 1;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    try {
      await takaro.variable.variableControllerCreate({
        key,
        value: JSON.stringify({ owner, expiresAt }),
        gameServerId,
        moduleId,
      });
      return {
        owner,
        key,
        async release() {
          const current = await findVariable(gameServerId, moduleId, key);
          if (!current) return;
          try {
            const value = JSON.parse(current.value);
            if (value?.owner === owner) {
              await takaro.variable.variableControllerDelete(current.id);
            }
          } catch {
            await takaro.variable.variableControllerDelete(current.id);
          }
        },
      };
    } catch (err) {
      const existing = await findVariable(gameServerId, moduleId, key);
      if (existing) {
        try {
          const parsed = JSON.parse(existing.value);
          if (parsed?.expiresAt && new Date(parsed.expiresAt).getTime() <= Date.now()) {
            await takaro.variable.variableControllerDelete(existing.id);
            continue;
          }
        } catch {
          await takaro.variable.variableControllerDelete(existing.id);
          continue;
        }
      }
    }
  }

  throw new Error(`Timed out acquiring casino lock ${scope}`);
}

export async function withCasinoLocks(gameServerId, moduleId, scopes, fn, options) {
  const uniqueScopes = [...new Set(scopes.filter(Boolean))].sort();
  const locks = [];
  try {
    for (const scope of uniqueScopes) {
      locks.push(await acquireLock(gameServerId, moduleId, scope, options));
    }
    return await fn();
  } finally {
    for (const lock of locks.reverse()) {
      await lock.release();
    }
  }
}

export async function readJsonVariable(gameServerId, moduleId, key, playerId, fallback) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  if (!existing) return fallback;
  try {
    return JSON.parse(existing.value);
  } catch (err) {
    console.error(`casino-helpers: failed to parse variable ${key} for player=${playerId ?? 'global'}: ${err}`);
    return fallback;
  }
}

export async function getPlayerStats(gameServerId, moduleId, playerId) {
  const stats = await readJsonVariable(gameServerId, moduleId, KEY_STATS, playerId, null);
  return { ...DEFAULT_STATS, ...(stats ?? {}), perGame: { ...(stats?.perGame ?? {}) } };
}

export async function setPlayerStats(gameServerId, moduleId, playerId, stats) {
  await writeVariable(gameServerId, moduleId, KEY_STATS, stats, playerId);
}

export async function getWindowData(gameServerId, moduleId, playerId, config) {
  const windowKey = getCurrentWindowKey(config.capWindow);
  const data = await readJsonVariable(gameServerId, moduleId, getWindowKey(windowKey), playerId, {
    wagered: 0,
    lost: 0,
    windowKey,
    capConfig: null,
  });
  const currentCapConfig = {
    capWindow: config.capWindow,
    wagerCap: Number(config.wagerCap ?? 0),
    lossCap: Number(config.lossCap ?? 0),
  };
  const previousCapConfig = data?.capConfig ?? null;
  const capConfigChanged = !previousCapConfig
    || previousCapConfig.capWindow !== currentCapConfig.capWindow
    || Number(previousCapConfig.wagerCap ?? 0) !== currentCapConfig.wagerCap
    || Number(previousCapConfig.lossCap ?? 0) !== currentCapConfig.lossCap;

  if (capConfigChanged) {
    return { wagered: 0, lost: 0, windowKey, capConfig: currentCapConfig };
  }

  return {
    wagered: Number(data?.wagered ?? 0),
    lost: Number(data?.lost ?? 0),
    windowKey,
    capConfig: currentCapConfig,
  };
}

export async function setWindowData(gameServerId, moduleId, playerId, windowKey, data) {
  await writeVariable(gameServerId, moduleId, getWindowKey(windowKey), {
    wagered: Number(data.wagered ?? 0),
    lost: Number(data.lost ?? 0),
    windowKey,
    capConfig: data.capConfig ?? null,
  }, playerId);
}

export async function getJackpot(gameServerId, moduleId) {
  const jackpot = await readJsonVariable(gameServerId, moduleId, KEY_JACKPOT, undefined, null);
  return {
    amount: Number(jackpot?.amount ?? 0),
    lastWinner: jackpot?.lastWinner ?? null,
    lastWinAt: jackpot?.lastWinAt ?? null,
    lastWinGame: jackpot?.lastWinGame ?? null,
  };
}

export async function setJackpot(gameServerId, moduleId, jackpot) {
  await writeVariable(gameServerId, moduleId, KEY_JACKPOT, {
    amount: Number(jackpot.amount ?? 0),
    lastWinner: jackpot.lastWinner ?? null,
    lastWinAt: jackpot.lastWinAt ?? null,
    lastWinGame: jackpot.lastWinGame ?? null,
  });
}

export async function getLeaderboardCache(gameServerId, moduleId) {
  return await readJsonVariable(gameServerId, moduleId, KEY_LEADERBOARD, undefined, {
    topWager: [],
    topWon: [],
    topRoi: [],
    topWinrate: [],
    topBiggest: [],
    refreshedAt: null,
  });
}

export async function setLeaderboardCache(gameServerId, moduleId, data) {
  await writeVariable(gameServerId, moduleId, KEY_LEADERBOARD, data);
}

export async function getRacePool(gameServerId, moduleId) {
  return await readJsonVariable(gameServerId, moduleId, KEY_RACE_POOL, undefined, {
    participants: [],
    drawAt: null,
    status: 'open',
  });
}

export async function setRacePool(gameServerId, moduleId, data) {
  await writeVariable(gameServerId, moduleId, KEY_RACE_POOL, data);
}

export async function mutateRacePool(gameServerId, moduleId, mutator) {
  return await withCasinoLocks(gameServerId, moduleId, ['race-pool'], async () => {
    const pool = await getRacePool(gameServerId, moduleId);
    const next = await mutator(pool);
    if (next !== undefined) {
      await setRacePool(gameServerId, moduleId, next);
    }
    return next;
  });
}

export async function getPlayerSession(gameServerId, moduleId, key, playerId) {
  return await readJsonVariable(gameServerId, moduleId, key, playerId, null);
}

export async function setPlayerSession(gameServerId, moduleId, key, playerId, value) {
  await writeVariable(gameServerId, moduleId, key, value, playerId);
}

export async function deletePlayerSession(gameServerId, moduleId, key, playerId) {
  await deleteVariable(gameServerId, moduleId, key, playerId);
}

export async function getDuel(gameServerId, moduleId, challengerId) {
  return await readJsonVariable(gameServerId, moduleId, KEY_DUEL, challengerId, null);
}

export async function setDuel(gameServerId, moduleId, challengerId, duel) {
  await writeVariable(gameServerId, moduleId, KEY_DUEL, duel, challengerId);
}

export async function deleteDuel(gameServerId, moduleId, challengerId) {
  await deleteVariable(gameServerId, moduleId, KEY_DUEL, challengerId);
}

export async function getBan(gameServerId, moduleId, playerId) {
  return await readJsonVariable(gameServerId, moduleId, KEY_BAN, playerId, null);
}

export async function setBan(gameServerId, moduleId, playerId, ban) {
  await writeVariable(gameServerId, moduleId, KEY_BAN, ban, playerId);
}

export async function clearBan(gameServerId, moduleId, playerId) {
  await deleteVariable(gameServerId, moduleId, KEY_BAN, playerId);
}

export async function ensurePlayerNotBanned(gameServerId, moduleId, playerId) {
  const ban = await getBan(gameServerId, moduleId, playerId);
  if (!ban) return;
  if (ban.expiresAt && new Date(ban.expiresAt).getTime() <= Date.now()) {
    await clearBan(gameServerId, moduleId, playerId);
    return;
  }
  const until = ban.expiresAt ? ` until ${formatUtcTimestamp(ban.expiresAt)}` : '';
  throw new TakaroUserError(`You are banned from the casino${until}.`);
}

export async function getPlayerName(playerId) {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data.name || playerId;
  } catch (err) {
    console.error(`casino-helpers: failed to resolve player name for ${playerId}: ${err}`);
    return playerId;
  }
}

export async function getPlayerOnGameserver(gameServerId, playerId) {
  const pogSearch = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      playerId: [playerId],
      gameServerId: [gameServerId],
    },
    limit: 1,
  });
  return pogSearch.data.data[0] ?? null;
}

export async function resolvePlayerByName(name, gameServerId) {
  const normalized = String(name).trim().toLowerCase();
  const playerSearch = await takaro.player.playerControllerSearch({ search: { name: [name] }, limit: 100 });
  const exact = playerSearch.data.data.find((p) => p.name.toLowerCase() === normalized);
  if (!exact) return null;
  const pog = await getPlayerOnGameserver(gameServerId, exact.id);
  if (!pog) return null;
  return {
    playerId: exact.id,
    player: exact,
    pog,
    gameServerId,
  };
}

export async function getPlayerBalance(gameServerId, playerId) {
  const pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId)).data.data;
  return Number(pog.currency ?? 0);
}

export async function assertNoLegacyCasinoModules(gameServerId, moduleId) {
  const legacyNames = new Set(['blackjack', 'roulette', 'slotmachines', 'hangman', 'horseracing', 'pvpbet']);
  const res = await takaro.module.moduleInstallationsControllerGetInstalledModules({
    filters: { gameserverId: [gameServerId] },
    limit: 100,
  });
  const conflicts = (res.data.data ?? []).filter((row) => {
    if (row.moduleId === moduleId) return false;
    const normalized = String(row.module?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return legacyNames.has(normalized);
  });
  if (conflicts.length > 0) {
    const names = conflicts.map((row) => row.module?.name).filter(Boolean).join(', ');
    throw new TakaroUserError(`Casino cannot run while old gambling modules are still installed: ${names}. Uninstall them before using /casino.`);
  }
}

export async function recordReportDay(gameServerId, moduleId, { playerId, playerName, game, betAmount, payout, occurredAt = nowIso() }) {
  const day = String(occurredAt).slice(0, 10);
  const dayKey = `${KEY_REPORT_DAY_PREFIX}:${day}`;

  await withCasinoLocks(gameServerId, moduleId, [`report-day:${day}`], async () => {
    const current = await readJsonVariable(gameServerId, moduleId, dayKey, undefined, {
      day,
      totalWagered: 0,
      totalWon: 0,
      houseProfit: 0,
      perGame: {},
      players: {},
    });

    current.totalWagered = Number(current.totalWagered ?? 0) + roundCurrency(betAmount);
    current.totalWon = Number(current.totalWon ?? 0) + roundCurrency(payout);
    current.houseProfit = Number(current.houseProfit ?? 0) + roundCurrency(betAmount) - roundCurrency(payout);

    const gameRow = current.perGame?.[game] ?? { wagered: 0, won: 0, plays: 0 };
    gameRow.wagered += roundCurrency(betAmount);
    gameRow.won += roundCurrency(payout);
    gameRow.plays += 1;
    current.perGame = { ...(current.perGame ?? {}), [game]: gameRow };

    const playerRow = current.players?.[playerId] ?? { name: playerName, wagered: 0, won: 0, net: 0 };
    playerRow.name = playerName;
    playerRow.wagered += roundCurrency(betAmount);
    playerRow.won += roundCurrency(payout);
    playerRow.net += roundCurrency(payout) - roundCurrency(betAmount);
    current.players = { ...(current.players ?? {}), [playerId]: playerRow };

    await writeVariable(gameServerId, moduleId, dayKey, current);
  });
}

export async function maybeAnnounceBigWin({ gameServerId, moduleId, playerId, playerName, game, net, config, jackpotWin = false, payout = 0, betAmount = 0 }) {
  if (!(jackpotWin || net >= config.bigWinThreshold)) return;

  const prefix = jackpotWin ? '💥 JACKPOT!' : '🎉 BIG WIN!';
  const meta = {
    type: 'casino-big-win',
    jackpotWin,
    playerId,
    playerName,
    game,
    net: roundCurrency(net),
    payout: roundCurrency(payout),
    betAmount: roundCurrency(betAmount),
    threshold: roundCurrency(config.bigWinThreshold),
    occurredAt: nowIso(),
    message: `${prefix} ${playerName} won ${formatCurrency(net)} on ${game}!`,
  };
  const payload = {
    eventName: 'chat-message',
    gameserverId: gameServerId,
    moduleId,
    actingModuleId: moduleId,
    playerId,
    meta,
  };

  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: meta.message,
      opts: {},
    });
  } catch (err) {
    console.error(`casino-helpers: failed to announce big win for ${playerName}: ${err}`);
  }

  try {
    if (takaro.event?.eventControllerCreate) {
      await takaro.event.eventControllerCreate(payload);
      return;
    }
    if (takaro.axios?.post) {
      await takaro.axios.post('/event', payload);
      return;
    }
    console.error(`casino-helpers: failed to emit casino-big-win event for ${playerName}: no event client available`);
  } catch (err) {
    console.error(`casino-helpers: failed to emit casino-big-win event for ${playerName}: ${err}`);
  }
}

export async function placeBet({ gameServerId, moduleId, pog, player, config, game, amount, skipLock = false }) {
  const run = async () => {
    requirePlayPermission(pog);
    await assertNoLegacyCasinoModules(gameServerId, moduleId);
    await ensurePlayerNotBanned(gameServerId, moduleId, player.id);
    if (!getGameEnabled(config, game)) {
      throw new TakaroUserError(`The ${game} game is disabled on this server.`);
    }

    const vipTier = getVipTier(pog);
    const vipMultiplier = getVipMultiplier(vipTier);
    const betAmount = validateBetAmount(amount, config, vipTier);

    const cooldown = await readJsonVariable(gameServerId, moduleId, KEY_COOLDOWN, player.id, null);
    const cooldownUntil = cooldown?.until ? new Date(cooldown.until).getTime() : 0;
    if (cooldownUntil > Date.now()) {
      const seconds = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
      throw new TakaroUserError(`Slow down — you can bet again in ${seconds}s.`);
    }

    const windowData = await getWindowData(gameServerId, moduleId, player.id, config);
    if (config.wagerCap > 0) {
      const wagerCap = Math.floor(config.wagerCap * vipMultiplier);
      if (windowData.wagered + betAmount > wagerCap) {
        throw new TakaroUserError(`That bet would exceed your ${config.capWindow} wager cap of ${formatCurrency(wagerCap)}.`);
      }
    }
    if (config.lossCap > 0) {
      const lossCap = Math.floor(config.lossCap * vipMultiplier);
      if (windowData.lost >= lossCap) {
        throw new TakaroUserError(`You already reached your ${config.capWindow} loss cap of ${formatCurrency(lossCap)}.`);
      }
    }

    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, player.id, {
        currency: betAmount,
      });
    } catch (err) {
      console.error(`casino-helpers: placeBet deduction failed for ${player.name}: ${err}`);
      throw new TakaroUserError('You do not have enough currency for that bet.');
    }

    try {
      windowData.wagered += betAmount;
      await setWindowData(gameServerId, moduleId, player.id, windowData.windowKey, windowData);

      if (config.cooldownSeconds > 0) {
        await writeVariable(gameServerId, moduleId, KEY_COOLDOWN, { until: new Date(Date.now() + (config.cooldownSeconds * 1000)).toISOString() }, player.id);
      }
    } catch (err) {
      console.error(`casino-helpers: placeBet persistence failed for ${player.name}, refunding deduction: ${err}`);
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, player.id, {
          currency: betAmount,
        });
      } catch (refundErr) {
        console.error(`casino-helpers: placeBet refund after persistence failure also failed for ${player.name}: ${refundErr}`);
      }
      throw new TakaroUserError('Your bet could not be saved. No currency was taken — please try again.');
    }

    return {
      amount: betAmount,
      vipTier,
      vipMultiplier,
      edgeFraction: getEffectiveEdgeFraction(config, vipTier),
      windowKey: windowData.windowKey,
    };
  };

  if (skipLock) return await run();
  return await withCasinoLocks(gameServerId, moduleId, [`player:${player.id}`], run);
}

export async function settle({ gameServerId, moduleId, player, config, game, betAmount, payout, jackpotWin = false, skipLock = false, announceBigWin = true }) {
  const run = async () => {
    const safeBet = roundCurrency(betAmount);
    const safePayout = roundCurrency(payout);

    if (safePayout > 0) {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, player.id, {
        currency: safePayout,
      });
    }

    const net = safePayout - safeBet;
    const stats = await getPlayerStats(gameServerId, moduleId, player.id);
    const isWinningRound = safePayout > safeBet;
    const currentGame = stats.perGame[game] ?? { wagered: 0, won: 0, plays: 0, wins: 0 };
    currentGame.wagered += safeBet;
    currentGame.won += safePayout;
    currentGame.plays += 1;
    currentGame.wins = Number(currentGame.wins ?? 0) + (isWinningRound ? 1 : 0);
    stats.perGame[game] = currentGame;
    stats.wagered += safeBet;
    stats.won += safePayout;
    stats.net += net;
    stats.gamesPlayed += 1;
    stats.wins = Number(stats.wins ?? 0) + (isWinningRound ? 1 : 0);
    if (safePayout > Number(stats.biggestWin?.amount ?? 0)) {
      stats.biggestWin = { amount: safePayout, game, at: nowIso() };
    }
    await setPlayerStats(gameServerId, moduleId, player.id, stats);

    let jackpotContribution = 0;
    let jackpot = await getJackpot(gameServerId, moduleId);
    if (net < 0) {
      const windowData = await getWindowData(gameServerId, moduleId, player.id, config);
      windowData.lost += Math.abs(net);
      await setWindowData(gameServerId, moduleId, player.id, windowData.windowKey, windowData);

      jackpotContribution = roundCurrency(Math.abs(net) * (config.jackpotContributionPct / 100));
      jackpot.amount += jackpotContribution;
      await setJackpot(gameServerId, moduleId, jackpot);
    }

    if (jackpotWin) {
      jackpot.lastWinner = player.name;
      jackpot.lastWinAt = nowIso();
      jackpot.lastWinGame = game;
      await setJackpot(gameServerId, moduleId, jackpot);
    }

    await recordReportDay(gameServerId, moduleId, {
      playerId: player.id,
      playerName: player.name,
      game,
      betAmount: safeBet,
      payout: safePayout,
      occurredAt: nowIso(),
    });

    if (announceBigWin) {
      await maybeAnnounceBigWin({ gameServerId, moduleId, playerId: player.id, playerName: player.name, game, net, config, jackpotWin, payout: safePayout, betAmount: safeBet });
    }

    const balance = await getPlayerBalance(gameServerId, player.id);
    return { net, balance, jackpotContribution, jackpot };
  };

  if (skipLock) return await run();
  return await withCasinoLocks(gameServerId, moduleId, ['jackpot', `player:${player.id}`], run);
}

export async function refund({ gameServerId, moduleId, playerId, amount, config, skipLock = false }) {
  const run = async () => {
    const safeAmount = roundCurrency(amount);
    if (safeAmount <= 0) return;
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: safeAmount });
    const windowData = await getWindowData(gameServerId, moduleId, playerId, config);
    windowData.wagered = Math.max(0, windowData.wagered - safeAmount);
    await setWindowData(gameServerId, moduleId, playerId, windowData.windowKey, windowData);
  };

  if (skipLock) return await run();
  return await withCasinoLocks(gameServerId, moduleId, [`player:${playerId}`], run);
}

export async function listAllStats(gameServerId, moduleId) {
  const results = [];
  let page = 0;
  const limit = 100;
  while (page < 100) {
    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [KEY_STATS],
        gameServerId: [gameServerId],
        moduleId: [moduleId],
      },
      page,
      limit,
    });
    const batch = res.data.data;
    for (const row of batch) {
      if (!row.playerId) continue;
      try {
        results.push({ playerId: row.playerId, stats: { ...DEFAULT_STATS, ...JSON.parse(row.value), perGame: { ...(JSON.parse(row.value).perGame ?? {}) } } });
      } catch (err) {
        console.error(`casino-helpers: failed to parse stats row ${row.id}: ${err}`);
      }
    }
    if (batch.length < limit) break;
    page += 1;
  }
  return results;
}

export async function refreshLeaderboardCache(gameServerId, moduleId) {
  const all = await listAllStats(gameServerId, moduleId);
  const enriched = await Promise.all(all.map(async (entry) => ({
    playerId: entry.playerId,
    name: await getPlayerName(entry.playerId),
    wagered: Number(entry.stats.wagered ?? 0),
    won: Number(entry.stats.won ?? 0),
    biggest: Number(entry.stats.biggestWin?.amount ?? 0),
    gamesPlayed: Number(entry.stats.gamesPlayed ?? 0),
    wins: Number(entry.stats.wins ?? 0),
    roi: entry.stats.wagered > 0 ? Number(((entry.stats.won / entry.stats.wagered) * 100).toFixed(2)) : 0,
    winrate: Number(entry.stats.gamesPlayed ?? 0) > 0 ? Number((((Number(entry.stats.wins ?? 0)) / Number(entry.stats.gamesPlayed ?? 0)) * 100).toFixed(2)) : 0,
  })));

  const roiEligible = [...enriched].filter((e) => e.gamesPlayed >= 3);
  const winrateEligible = [...enriched].filter((e) => e.gamesPlayed >= 3);
  const cache = {
    topWager: [...enriched].sort((a, b) => b.wagered - a.wagered).slice(0, 10),
    topWon: [...enriched].sort((a, b) => b.won - a.won).slice(0, 10),
    topRoi: (roiEligible.length > 0 ? roiEligible : [...enriched]).sort((a, b) => b.roi - a.roi).slice(0, 10),
    topWinrate: (winrateEligible.length > 0 ? winrateEligible : [...enriched]).sort((a, b) => b.winrate - a.winrate).slice(0, 10),
    topBiggest: [...enriched].sort((a, b) => b.biggest - a.biggest).slice(0, 10),
    refreshedAt: nowIso(),
  };
  await setLeaderboardCache(gameServerId, moduleId, cache);
  return cache;
}

export function pickWeightedWinner(participants) {
  const total = participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  if (total <= 0) return null;
  let cursor = Math.random() * total;
  for (const participant of participants) {
    cursor -= Number(participant.amount ?? 0);
    if (cursor <= 0) return participant;
  }
  return participants[participants.length - 1] ?? null;
}

export function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit });
    }
  }
  return shuffle(deck);
}

export function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function cardLabel(card) {
  const map = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  return `${map[card.rank] ?? card.rank}${card.suit}`;
}

export function cardValue(rank) {
  if (rank === 1) return 11;
  if (rank >= 10) return 10;
  return rank;
}

export function handTotal(hand) {
  let total = hand.reduce((sum, card) => sum + cardValue(card.rank), 0);
  let aces = hand.filter((card) => card.rank === 1).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

export function isSoft17(hand) {
  const total = hand.reduce((sum, card) => sum + cardValue(card.rank), 0);
  const aces = hand.filter((card) => card.rank === 1).length;
  return aces > 0 && total === 17;
}

export function rouletteColor(number) {
  if (number === 0) return 'green';
  const red = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  return red.has(number) ? 'red' : 'black';
}

export function parseRouletteSelection(input) {
  const raw = String(input ?? '').toLowerCase();
  if (['red', 'black', 'odd', 'even', 'green'].includes(raw)) return { type: raw, value: raw };
  const number = Number(raw);
  if (Number.isInteger(number) && number >= 0 && number <= 36) return { type: 'number', value: number };
  throw new TakaroUserError('Pick red, black, odd, even, green, or a number from 0 to 36.');
}

export function rouletteWin(selection, spin) {
  if (selection.type === 'number') return spin === selection.value;
  if (selection.type === 'green') return spin === 0;
  if (selection.type === 'red' || selection.type === 'black') return spin !== 0 && rouletteColor(spin) === selection.type;
  if (selection.type === 'odd') return spin !== 0 && spin % 2 === 1;
  if (selection.type === 'even') return spin !== 0 && spin % 2 === 0;
  return false;
}

export const SLOT_SYMBOLS = [
  { emoji: '🍒', weight: 30, triple: 3 },
  { emoji: '🍋', weight: 20, triple: 5 },
  { emoji: '🍇', weight: 15, triple: 8 },
  { emoji: '🔔', weight: 10, triple: 15 },
  { emoji: '⭐', weight: 5, triple: 30 },
  { emoji: '💎', weight: 2, triple: 75 },
  { emoji: '7️⃣', weight: 1, triple: null },
];

export function getSlotSymbolByEmoji(emoji) {
  return SLOT_SYMBOLS.find((symbol) => symbol.emoji === emoji) ?? null;
}

export function pickSlotSymbol() {
  const total = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
  let cursor = Math.random() * total;
  for (const symbol of SLOT_SYMBOLS) {
    cursor -= symbol.weight;
    if (cursor <= 0) return symbol;
  }
  return SLOT_SYMBOLS[0];
}

export function makeCrashPoint(edgeFraction) {
  const u = Math.random();
  if (u < edgeFraction) return 1;
  const raw = ((1 - edgeFraction) / (1 - u));
  return Math.min(1000, Math.max(1, Math.round(raw * 100) / 100));
}

export function parsePositiveNumberLike(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

export async function ensureInteractivePlayAllowed(gameServerId, moduleId, pog, player, config, game) {
  requirePlayPermission(pog);
  await ensurePlayerNotBanned(gameServerId, moduleId, player.id);
  if (!getGameEnabled(config, game)) {
    throw new TakaroUserError(`The ${game} game is disabled on this server.`);
  }
}

export async function sweepExpiredBans(gameServerId, moduleId) {
  const deleted = [];
  let page = 0;
  while (page < 100) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [KEY_BAN], gameServerId: [gameServerId], moduleId: [moduleId] },
      page,
      limit: 100,
    });
    const batch = res.data.data;
    for (const row of batch) {
      if (!row.playerId) continue;
      try {
        const ban = JSON.parse(row.value);
        if (ban?.expiresAt && new Date(ban.expiresAt).getTime() <= Date.now()) {
          await takaro.variable.variableControllerDelete(row.id);
          deleted.push(row.playerId);
        }
      } catch (err) {
        console.error(`casino-helpers: failed to parse ban ${row.id}: ${err}`);
      }
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return deleted;
}

export async function sweepExpiredWindows(gameServerId, moduleId, config) {
  const keep = new Set([getCurrentWindowKey(config.capWindow), getPreviousWindowKey(config.capWindow)]);
  let deleted = 0;
  let page = 0;
  while (page < 100) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { gameServerId: [gameServerId], moduleId: [moduleId] },
      search: { key: [KEY_WINDOW_PREFIX] },
      page,
      limit: 100,
    });
    const batch = res.data.data.filter((row) => row.key.startsWith(`${KEY_WINDOW_PREFIX}:`));
    for (const row of batch) {
      const key = row.key.slice(`${KEY_WINDOW_PREFIX}:`.length);
      if (!keep.has(key)) {
        await takaro.variable.variableControllerDelete(row.id);
        deleted += 1;
      }
    }
    if (res.data.data.length < 100) break;
    page += 1;
  }
  return deleted;
}

export async function listDuels(gameServerId, moduleId) {
  const duels = [];
  let page = 0;
  while (page < 100) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [KEY_DUEL], gameServerId: [gameServerId], moduleId: [moduleId] },
      page,
      limit: 100,
    });
    const batch = res.data.data;
    for (const row of batch) {
      try {
        duels.push({ challengerId: row.playerId, duel: JSON.parse(row.value) });
      } catch (err) {
        console.error(`casino-helpers: failed to parse duel ${row.id}: ${err}`);
      }
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return duels;
}

export async function findDuelForPlayer(gameServerId, moduleId, playerId) {
  const matches = (await listDuels(gameServerId, moduleId)).filter(({ challengerId, duel }) => (
    challengerId === playerId || duel.opponentId === playerId
  ));
  if (matches.length > 1) {
    throw new TakaroUserError('You are already involved in multiple duel requests. Ask an admin to clear stale duels.');
  }
  return matches[0] ?? null;
}

export async function sweepExpiredSessions(gameServerId, moduleId, config) {
  const now = Date.now();
  const actions = [];

  for (const key of [KEY_HILO_SESSION, KEY_BLACKJACK_SESSION]) {
    let page = 0;
    while (page < 100) {
      const res = await takaro.variable.variableControllerSearch({
        filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] },
        page,
        limit: 100,
      });
      const batch = res.data.data;
      for (const row of batch) {
        if (!row.playerId) continue;
        try {
          const session = JSON.parse(row.value);
          const startedAt = new Date(session.startedAt).getTime();
          if (startedAt && now - startedAt >= 15 * 60 * 1000) {
            await withCasinoLocks(gameServerId, moduleId, [`player:${row.playerId}`], async () => {
              const current = await getPlayerSession(gameServerId, moduleId, key, row.playerId);
              if (!current) return;
              const currentStartedAt = new Date(current.startedAt).getTime();
              if (!(currentStartedAt && now - currentStartedAt >= 15 * 60 * 1000)) return;
              await refund({ gameServerId, moduleId, playerId: row.playerId, amount: current.stake, config, skipLock: true });
              await deletePlayerSession(gameServerId, moduleId, key, row.playerId);
              actions.push({ type: 'refund', playerId: row.playerId, key, amount: current.stake });
            });
          }
        } catch (err) {
          console.error(`casino-helpers: failed to parse session ${row.id}: ${err}`);
        }
      }
      if (batch.length < 100) break;
      page += 1;
    }
  }

  let duelPage = 0;
  while (duelPage < 100) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [KEY_DUEL], gameServerId: [gameServerId], moduleId: [moduleId] },
      page: duelPage,
      limit: 100,
    });
    const batch = res.data.data;
    for (const row of batch) {
      if (!row.playerId) continue;
      try {
        const duel = JSON.parse(row.value);
        const startedAt = new Date(duel.startedAt).getTime();
        const ttlMs = duel.state === 'accepted' ? 3 * 60 * 1000 : 60 * 1000;
        if (startedAt && now - startedAt >= ttlMs) {
          await withCasinoLocks(gameServerId, moduleId, ['duel-registry', `player:${row.playerId}`, `player:${duel.opponentId}`], async () => {
            const current = await getDuel(gameServerId, moduleId, row.playerId);
            if (!current) return;
            const currentStartedAt = new Date(current.startedAt).getTime();
            const currentTtlMs = current.state === 'accepted' ? 3 * 60 * 1000 : 60 * 1000;
            if (!(currentStartedAt && now - currentStartedAt >= currentTtlMs)) return;
            await refund({ gameServerId, moduleId, playerId: row.playerId, amount: current.amount, config, skipLock: true });
            if (current.acceptedStakePlaced && current.opponentId) {
              await refund({ gameServerId, moduleId, playerId: current.opponentId, amount: current.amount, config, skipLock: true });
            }
            await deleteDuel(gameServerId, moduleId, row.playerId);
            actions.push({ type: 'duel-expired', challengerId: row.playerId, opponentId: current.opponentId, amount: current.amount });
          });
        }
      } catch (err) {
        console.error(`casino-helpers: failed to parse duel row ${row.id}: ${err}`);
      }
    }
    if (batch.length < 100) break;
    duelPage += 1;
  }

  return actions;
}

export async function handleDisconnect(gameServerId, moduleId, playerId, config) {
  const refunds = [];

  await withCasinoLocks(gameServerId, moduleId, [`player:${playerId}`], async () => {
    for (const key of [KEY_HILO_SESSION, KEY_BLACKJACK_SESSION]) {
      const session = await getPlayerSession(gameServerId, moduleId, key, playerId);
      if (!session) continue;
      await refund({ gameServerId, moduleId, playerId, amount: session.stake, config, skipLock: true });
      await deletePlayerSession(gameServerId, moduleId, key, playerId);
      refunds.push({ key, amount: session.stake });
    }
  });

  const duelRecord = await findDuelForPlayer(gameServerId, moduleId, playerId);
  if (duelRecord) {
    await withCasinoLocks(gameServerId, moduleId, ['duel-registry', `player:${duelRecord.challengerId}`, `player:${duelRecord.duel.opponentId}`], async () => {
      const current = await getDuel(gameServerId, moduleId, duelRecord.challengerId);
      if (!current) return;
      await refund({ gameServerId, moduleId, playerId: duelRecord.challengerId, amount: current.amount, config, skipLock: true });
      if (current.acceptedStakePlaced && current.opponentId) {
        await refund({ gameServerId, moduleId, playerId: current.opponentId, amount: current.amount, config, skipLock: true });
      }
      await deleteDuel(gameServerId, moduleId, duelRecord.challengerId);
      refunds.push({ key: KEY_DUEL, amount: current.amount });
    });
  }

  return refunds;
}

export function getNextWindowResetAt(capWindow) {
  const now = new Date();
  if (capWindow === 'weekly') {
    const day = now.getUTCDay() || 7;
    const diff = 8 - day;
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff, 0, 0, 0));
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
}

export async function settleJackpotWin({ gameServerId, moduleId, player, config, game, betAmount }) {
  return await withCasinoLocks(gameServerId, moduleId, ['jackpot', `player:${player.id}`], async () => {
    const jackpot = await getJackpot(gameServerId, moduleId);
    const payout = roundCurrency(jackpot.amount);
    const result = await settle({
      gameServerId,
      moduleId,
      player,
      config,
      game,
      betAmount,
      payout,
      skipLock: true,
      announceBigWin: false,
    });
    jackpot.amount = 0;
    jackpot.lastWinner = player.name;
    jackpot.lastWinAt = nowIso();
    jackpot.lastWinGame = game;
    await setJackpot(gameServerId, moduleId, jackpot);
    await maybeAnnounceBigWin({
      gameServerId,
      moduleId,
      playerId: player.id,
      playerName: player.name,
      game,
      net: payout - roundCurrency(betAmount),
      config,
      jackpotWin: true,
      payout,
      betAmount,
    });
    return { ...result, payout, jackpot };
  });
}

export async function generateReport(gameServerId, moduleId, days = 7) {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 7)));
  const report = {
    days: safeDays,
    totalWagered: 0,
    totalWon: 0,
    houseProfit: 0,
    top5: [],
    perGame: {},
  };

  const players = {};
  for (let i = 0; i < safeDays; i += 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    const dayKey = `${KEY_REPORT_DAY_PREFIX}:${date.toISOString().slice(0, 10)}`;
    const row = await readJsonVariable(gameServerId, moduleId, dayKey, undefined, null);
    if (!row) continue;
    report.totalWagered += Number(row.totalWagered ?? 0);
    report.totalWon += Number(row.totalWon ?? 0);
    report.houseProfit += Number(row.houseProfit ?? 0);
    for (const [game, gameRow] of Object.entries(row.perGame ?? {})) {
      const current = report.perGame[game] ?? { wagered: 0, won: 0, plays: 0 };
      current.wagered += Number(gameRow.wagered ?? 0);
      current.won += Number(gameRow.won ?? 0);
      current.plays += Number(gameRow.plays ?? 0);
      report.perGame[game] = current;
    }
    for (const [playerId, playerRow] of Object.entries(row.players ?? {})) {
      const current = players[playerId] ?? { name: playerRow.name ?? await getPlayerName(playerId), wagered: 0, won: 0, net: 0 };
      current.name = playerRow.name ?? current.name;
      current.wagered += Number(playerRow.wagered ?? 0);
      current.won += Number(playerRow.won ?? 0);
      current.net += Number(playerRow.net ?? 0);
      players[playerId] = current;
    }
  }

  report.top5 = Object.values(players).sort((a, b) => b.wagered - a.wagered).slice(0, 5);
  return report;
}
