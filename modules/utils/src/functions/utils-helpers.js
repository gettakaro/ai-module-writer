import { takaro } from '@takaro/helpers';

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
  const parsedReasonSource = trimOrEmpty(argsReason) === '?' ? '' : trimOrEmpty(argsReason);
  const parsedReason = stripConsumedPrefix(parsedReasonSource, consumedValues);

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
    const playerId = trimOrEmpty(player?.playerId);
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

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimOrEmpty(value));
}

export async function findPlayerByToken(token) {
  const normalized = trimOrEmpty(token);
  if (normalized === '' || normalized === '?') return null;

  if (isUuidLike(normalized)) {
    try {
      const byId = await takaro.player.playerControllerSearch({
        filters: { id: [normalized] },
        limit: 1,
      });
      const exactIdMatch = byId.data.data[0];
      if (exactIdMatch) {
        return {
          playerId: exactIdMatch.id,
          name: trimOrEmpty(exactIdMatch.name) || 'Unknown Player',
        };
      }
    } catch (err) {
      console.error(`utils-helpers: player lookup by id failed for ${normalized}: ${err}`);
    }
  }

  const exactNameInputs = [normalized, normalized.toLowerCase()];
  for (const name of exactNameInputs) {
    try {
      const byName = await takaro.player.playerControllerSearch({
        filters: { name: [name] },
        limit: 10,
      });
      const exactNameMatch = byName.data.data.find(
        (player) => trimOrEmpty(player.name).toLowerCase() === normalized.toLowerCase(),
      );
      if (exactNameMatch) {
        return {
          playerId: exactNameMatch.id,
          name: trimOrEmpty(exactNameMatch.name) || normalized,
        };
      }
    } catch (err) {
      console.error(`utils-helpers: player lookup by exact name failed for ${normalized}: ${err}`);
    }
  }

  try {
    const fuzzy = await takaro.player.playerControllerSearch({
      search: { name: [normalized] },
      limit: 10,
    });
    const exactNameMatch = fuzzy.data.data.find(
      (player) => trimOrEmpty(player.name).toLowerCase() === normalized.toLowerCase(),
    );
    if (exactNameMatch) {
      return {
        playerId: exactNameMatch.id,
        name: trimOrEmpty(exactNameMatch.name) || normalized,
      };
    }
  } catch (err) {
    console.error(`utils-helpers: player fuzzy lookup failed for ${normalized}: ${err}`);
  }

  return null;
}

export async function resolveCommandTargetPlayer(gameServerId, token, { requireOnline = false } = {}) {
  const player = await findPlayerByToken(token);
  if (!player) return null;

  const pog = await getGameServerPogForPlayer(gameServerId, player.playerId);
  if (requireOnline && !pog?.online) {
    return {
      ...player,
      gameServerId,
      online: false,
      gameId: '',
    };
  }

  return {
    playerId: player.playerId,
    name: player.name,
    gameId: trimOrEmpty(pog?.gameId),
    gameServerId: trimOrEmpty(pog?.gameServerId) || gameServerId,
    online: pog?.online ?? false,
  };
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
