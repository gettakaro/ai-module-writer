import { takaro } from '@takaro/helpers';

export const UTILS_DEBUG_FORCE_GIVECURRENCY_API_FAILURE_KEY = '__debug_force_givecurrency_api_failure';
export const UTILS_DEBUG_FORCE_KICK_API_FAILURE_KEY = '__debug_force_kick_api_failure';
export const UTILS_DEBUG_FORCE_BAN_API_FAILURE_KEY = '__debug_force_ban_api_failure';

export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

export function trimOrEmpty(value) {
  return isBlank(value) ? '' : String(value).trim();
}

export function normalizeReason(value, fallback) {
  const trimmed = trimOrEmpty(value);
  return trimmed === '' ? fallback : trimmed;
}

function getChatMessageText(chatMessage) {
  return typeof chatMessage === 'string'
    ? chatMessage
    : (chatMessage && typeof chatMessage.msg === 'string' ? chatMessage.msg : '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripConsumedPrefix(text, consumedValues = []) {
  let remaining = trimOrEmpty(text);

  for (const value of consumedValues) {
    const normalized = trimOrEmpty(value);
    if (normalized === '') continue;
    const flexibleWhitespace = escapeRegex(normalized).replace(/\s+/g, '\\s+');
    const pattern = new RegExp(`^${flexibleWhitespace}(?:\\s+|$)`, 'i');
    remaining = remaining.replace(pattern, '');
  }

  return trimOrEmpty(remaining);
}

export function extractReason(argsReason, chatMessage, consumedValues = []) {
  const parsedReason = trimOrEmpty(argsReason) === '?' ? '' : trimOrEmpty(argsReason);

  let remaining = trimOrEmpty(getChatMessageText(chatMessage));
  if (remaining !== '') {
    remaining = remaining.replace(/^\S+\s*/, '');
    const reconstructedReason = stripConsumedPrefix(remaining, consumedValues);
    if (reconstructedReason !== '') {
      return reconstructedReason;
    }
  }

  return parsedReason;
}

export function compactRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => trimOrEmpty(rule))
    .filter((rule) => rule !== '');
}

export function formatOnlinePlayersLine(players) {
  const names = players
    .map((player) => trimOrEmpty(player.name || player.playerName))
    .filter((name) => name !== '')
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  if (names.length === 0) {
    return 'No players are currently online.';
  }

  const visible = names.slice(0, 10);
  const hiddenCount = Math.max(0, names.length - visible.length);
  const suffix = hiddenCount > 0 ? `, ... (+${hiddenCount} more)` : '';
  const noun = names.length === 1 ? 'player' : 'players';
  return `${names.length} ${noun} online: ${visible.join(', ')}${suffix}`;
}

export function collapsePlayersById(players) {
  const seen = new Set();
  const uniquePlayers = [];

  for (const player of players) {
    const playerId = trimOrEmpty(player?.playerId || player?.id);
    if (playerId === '' || seen.has(playerId)) continue;
    seen.add(playerId);
    uniquePlayers.push(player);
  }

  return uniquePlayers;
}

export async function collectPaginatedResults(fetchPage, { limit = 100, maxIterations = 100 } = {}) {
  const items = [];
  let page = 0;
  let iterations = 0;

  while (true) {
    iterations += 1;
    if (iterations > maxIterations) {
      console.error(`utils-pure: collectPaginatedResults exceeded ${maxIterations} iterations, aborting pagination`);
      break;
    }

    const result = await fetchPage({ page, limit });
    const batch = Array.isArray(result?.data) ? result.data : [];
    const total = typeof result?.total === 'number' ? result.total : undefined;

    items.push(...batch);

    if (batch.length === 0) break;
    if (total !== undefined && items.length >= total) break;
    if (batch.length < limit && total === undefined) break;

    page += 1;
  }

  return items;
}

export function getCommandTargetPlayer(target) {
  if (!target || typeof target !== 'object') return null;

  const playerId = trimOrEmpty(target.playerId || target.id);
  if (playerId === '') return null;

  return {
    playerId,
    name: trimOrEmpty(target.name || target.playerName) || 'Unknown Player',
    gameId: trimOrEmpty(target.gameId),
    gameServerId: trimOrEmpty(target.gameServerId),
    online: target.online,
  };
}

export function requireResolvedPlayerArgument(target) {
  const resolved = getCommandTargetPlayer(target);
  if (!resolved) {
    return null;
  }

  return {
    ...resolved,
    online: target?.online,
  };
}

export async function resolvePlayerTarget(value) {
  const token = trimOrEmpty(value);
  if (token === '') return null;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    try {
      const result = await takaro.player.playerControllerGetOne(token);
      return {
        playerId: result.data.data.id,
        name: trimOrEmpty(result.data.data.name) || 'Unknown Player',
      };
    } catch {
      return null;
    }
  }

  try {
    const byName = await takaro.player.playerControllerSearch({
      search: { name: [token] },
      limit: 10,
    });
    const exactNameMatch = byName.data.data.find((player) => trimOrEmpty(player.name).toLowerCase() === token.toLowerCase());
    if (!exactNameMatch) {
      return null;
    }

    return {
      playerId: exactNameMatch.id,
      name: trimOrEmpty(exactNameMatch.name) || 'Unknown Player',
    };
  } catch (err) {
    console.error(`utils-helpers: failed to resolve player token "${token}": ${err}`);
    return null;
  }
}

export function renderTemplate(template, placeholders) {
  const source = trimOrEmpty(template);
  return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(placeholders, key)) {
      return String(placeholders[key]);
    }
    return `{${key}}`;
  });
}

export function parseBanDurationToken(token) {
  const normalized = trimOrEmpty(token).toLowerCase();

  if (normalized === 'perm' || normalized === 'permanent') {
    return {
      isPermanent: true,
      expiresAt: undefined,
      humanDuration: 'permanent',
      normalizedToken: normalized,
    };
  }

  const match = normalized.match(/^(\d+)([mhdw])$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isInteger(amount) || amount <= 0) return null;

  const unitConfig = {
    m: { ms: 60 * 1000, singular: 'minute', plural: 'minutes' },
    h: { ms: 60 * 60 * 1000, singular: 'hour', plural: 'hours' },
    d: { ms: 24 * 60 * 60 * 1000, singular: 'day', plural: 'days' },
    w: { ms: 7 * 24 * 60 * 60 * 1000, singular: 'week', plural: 'weeks' },
  }[unit];

  if (!unitConfig) return null;

  const durationMs = amount * unitConfig.ms;
  const expiresAtMs = Date.now() + durationMs;
  if (!Number.isSafeInteger(durationMs) || !Number.isFinite(expiresAtMs) || expiresAtMs > 8.64e15) {
    return null;
  }

  return {
    isPermanent: false,
    expiresAt: new Date(expiresAtMs).toISOString(),
    humanDuration: `${amount} ${amount === 1 ? unitConfig.singular : unitConfig.plural}`,
    normalizedToken: normalized,
  };
}

export function getCommandArgumentTokens(chatMessage) {
  const text = trimOrEmpty(getChatMessageText(chatMessage));
  if (text === '') return [];
  return text.split(/\s+/).slice(1);
}

export async function fetchOnlinePlayers(gameServerId) {
  const players = await collectPaginatedResults(async ({ page, limit }) => {
    const result = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      page,
      limit,
    });

    return {
      data: result.data.data,
      total: result.data.meta?.total,
    };
  }, { limit: 5 });

  const uniquePlayers = collapsePlayersById(players);
  const namedPlayers = await Promise.all(uniquePlayers.map(async (player) => ({
    ...player,
    name: await getPlayerName(player.playerId, ''),
  })));

  return namedPlayers;
}

export async function getGameServerName(gameServerId) {
  try {
    const result = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
    return trimOrEmpty(result.data.data.name) || 'Unknown Server';
  } catch (err) {
    console.error(`utils-helpers: failed to load gameserver ${gameServerId}: ${err}`);
    return 'Unknown Server';
  }
}

export async function getPlayerName(playerId, fallback) {
  try {
    const result = await takaro.player.playerControllerGetOne(playerId);
    return trimOrEmpty(result.data.data.name) || fallback || 'Unknown Player';
  } catch (err) {
    console.error(`utils-helpers: failed to load player ${playerId}: ${err}`);
    return fallback || 'Unknown Player';
  }
}

export async function getGameServerPogForPlayer(gameServerId, playerId, { onlineOnly = false } = {}) {
  const filters = {
    gameServerId: [gameServerId],
    playerId: [playerId],
  };

  if (onlineOnly) {
    filters.online = [true];
  }

  const result = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters,
    limit: 1,
  });

  const pog = result.data.data[0];
  if (!pog) return null;

  return {
    playerId: pog.playerId,
    name: trimOrEmpty(pog.name) || '',
    gameId: pog.gameId,
    gameServerId: pog.gameServerId,
    online: pog.online,
  };
}

export async function getOnlinePogForPlayer(gameServerId, playerId) {
  return getGameServerPogForPlayer(gameServerId, playerId, { onlineOnly: true });
}

export async function isEconomyEnabled(gameServerId) {
  try {
    const result = await takaro.settings.settingsControllerGetOne('economyEnabled', gameServerId);
    return String(result.data.data.value).toLowerCase() === 'true';
  } catch (err) {
    console.error(`utils-helpers: failed to load economyEnabled for ${gameServerId}: ${err}`);
    return false;
  }
}

async function getUtilsVariable(gameServerId, moduleId, key) {
  const result = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
    limit: 1,
  });

  return result.data.data[0] ?? null;
}

export async function consumeUtilsDebugFlag(gameServerId, moduleId, key) {
  if (!moduleId) return false;

  const variable = await getUtilsVariable(gameServerId, moduleId, key);
  if (!variable) return false;

  let enabled = false;
  try {
    enabled = JSON.parse(variable.value) === true;
  } catch {
    enabled = false;
  }

  try {
    await takaro.variable.variableControllerDelete(variable.id);
  } catch (err) {
    console.warn(`utils-helpers: failed to delete debug flag ${key}: ${err}`);
  }

  return enabled;
}

export async function safeBroadcast(gameServerId, message) {
  if (isBlank(message)) return false;
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: {},
    });
    console.log(message);
    return true;
  } catch (err) {
    console.error(`utils-helpers: broadcast failed: ${err}`);
    return false;
  }
}

export async function safePrivateMessage(recipient, message) {
  if (!recipient || isBlank(message)) return false;
  try {
    await recipient.pm(message);
    console.log(message);
    return true;
  } catch (err) {
    console.error(`utils-helpers: private message failed: ${err}`);
    return false;
  }
}

export async function safeDirectMessage(gameServerId, recipient, message) {
  if (!recipient || !recipient.gameId || isBlank(message)) return false;
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: {
        recipient: {
          gameId: recipient.gameId,
        },
      },
    });
    console.log(message);
    return true;
  } catch (err) {
    console.error(`utils-helpers: direct message failed to player ${recipient.playerId}: ${err}`);
    return false;
  }
}

export function isPlayerOnlineHere(target, gameServerId) {
  if (!target) return false;
  if (target.gameServerId && target.gameServerId !== gameServerId) return false;
  if (target.online === false) return false;
  return Boolean(target.gameId);
}
