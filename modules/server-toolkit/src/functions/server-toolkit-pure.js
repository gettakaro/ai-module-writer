/**
 * Pure utility functions with no @takaro/helpers dependency.
 * These can be imported in tests without the Takaro sandbox.
 */

export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

export function trimOrEmpty(value) {
  return isBlank(value) ? '' : String(value).trim();
}

export function normalizeReason(value, fallback) {
  const trimmed = trimOrEmpty(value);
  return trimmed === '' || trimmed === '?' ? fallback : trimmed;
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
  const suffix = hiddenCount > 0 ? ', ...' : '';
  const noun = names.length === 1 ? 'player' : 'players';
  return `${names.length} ${noun} online: ${visible.join(', ')}${suffix}`;
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

export function renderTemplate(template, placeholders) {
  const source = trimOrEmpty(template);
  return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(placeholders, key)) {
      return String(placeholders[key]);
    }
    return `{${key}}`;
  });
}

/**
 * Parse a ban duration token such as "perm", "permanent", "10m", "12h", "7d", "2w".
 * Returns a parsed duration object or null if invalid.
 */
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
