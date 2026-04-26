import { takaro } from '@takaro/helpers';

function trimOrEmptyInternal(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return String(value).trim();
}

function collapsePlayersById(players) {
  const seen = new Set();
  const uniquePlayers = [];

  for (const player of players) {
    const playerId = String(player?.playerId || player?.id || '').trim();
    if (playerId === '' || seen.has(playerId)) continue;
    seen.add(playerId);
    uniquePlayers.push(player);
  }

  return uniquePlayers;
}

async function collectPaginatedResults(fetchPage, { limit = 100, maxIterations = 100 } = {}) {
  const items = [];

  for (let page = 0; page < maxIterations; page += 1) {
    const result = await fetchPage({ page, limit });
    const batch = Array.isArray(result?.data) ? result.data : [];
    const total = typeof result?.total === 'number' ? result.total : undefined;

    items.push(...batch);

    if (batch.length === 0) return items;
    if (total !== undefined && items.length >= total) return items;
    if (batch.length < limit && total === undefined) return items;
  }

  throw new Error(
    `collectPaginatedResults reached the ${maxIterations}-page safety limit before pagination completed.`,
  );
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
  }, { limit: 100, maxIterations: 1000 });

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
    const trimmed = trimOrEmptyInternal(result?.data?.data?.name);
    return trimmed || 'Unknown Server';
  } catch (err) {
    console.error(`server-toolkit-helpers: failed to load gameserver ${gameServerId}: ${err}`);
    return 'Unknown Server';
  }
}

export async function getPlayerName(playerId, fallback) {
  try {
    const result = await takaro.player.playerControllerGetOne(playerId);
    const trimmed = trimOrEmptyInternal(result?.data?.data?.name);
    return trimmed || fallback || 'Unknown Player';
  } catch (err) {
    console.error(`server-toolkit-helpers: failed to load player ${playerId}: ${err}`);
    return fallback || 'Unknown Player';
  }
}

export async function safeBroadcast(gameServerId, message) {
  const trimmed = trimOrEmptyInternal(message);
  if (trimmed === '') return false;
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: trimmed,
      opts: {},
    });
    console.log(`[broadcast] ${trimmed}`);
    return true;
  } catch (err) {
    console.error(`server-toolkit-helpers: broadcast failed: ${err}`);
    return false;
  }
}
