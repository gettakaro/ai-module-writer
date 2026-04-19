export function trimOrEmpty(value) {
  return value === undefined || value === null ? '' : String(value).trim();
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
