import { takaro, checkPermission } from '@takaro/helpers';

export const VOTE_STATE_KEY = 'vr_vote_state';
export const RESTART_STATE_KEY = 'vr_restart_state';
export const COOLDOWN_KEY = 'vr_cooldown_until';
export const LOCK_KEY = 'vr_state_lock';

export function sleep() {
  throw new Error('vote-helpers: sleep() is unavailable in the Takaro runtime');
}

// ── Generic variable CRUD ─────────────────────────────────────────────────────

export async function findVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export async function writeVariable(gameServerId, moduleId, key, value) {
  const existing = await findVariable(gameServerId, moduleId, key);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    await takaro.variable.variableControllerCreate({
      key,
      value: serialized,
      gameServerId,
      moduleId,
    });
  }
}

export async function removeVariable(gameServerId, moduleId, key) {
  const existing = await findVariable(gameServerId, moduleId, key);
  if (existing) {
    await takaro.variable.variableControllerDelete(existing.id);
  }
}

export async function acquireVoteLock(gameServerId, moduleId, { ttlMs = 15000, timeoutMs = 10000, retryMs = 100 } = {}) {
  const owner = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.max(10, Math.ceil(timeoutMs / Math.max(1, retryMs)));
  let attempts = 0;

  const searchLockRows = async () => {
    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [LOCK_KEY],
        gameServerId: [gameServerId],
        moduleId: [moduleId],
      },
      limit: 100,
    });
    return res.data.data;
  };

  while (Date.now() < deadline && attempts < maxAttempts) {
    attempts += 1;
    try {
      await takaro.variable.variableControllerCreate({
        key: LOCK_KEY,
        value: JSON.stringify({ owner, expiresAt: new Date(Date.now() + ttlMs).toISOString() }),
        gameServerId,
        moduleId,
      });
      return {
        async release() {
          const rows = await searchLockRows();
          for (const row of rows) {
            try {
              const parsed = JSON.parse(row.value);
              if (parsed?.owner === owner) {
                await takaro.variable.variableControllerDelete(row.id);
              }
            } catch {
              await takaro.variable.variableControllerDelete(row.id);
            }
          }
        },
      };
    } catch {
      const rows = await searchLockRows();
      let removedStaleRow = false;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.value);
          if (parsed?.expiresAt && new Date(parsed.expiresAt).getTime() <= Date.now()) {
            await takaro.variable.variableControllerDelete(row.id);
            removedStaleRow = true;
          }
        } catch {
          await takaro.variable.variableControllerDelete(row.id);
          removedStaleRow = true;
        }
      }
      if (removedStaleRow) continue;
    }
  }
  throw new Error('Timed out acquiring vote-restart state lock');
}

export async function withVoteLock(gameServerId, moduleId, fn) {
  const lock = await acquireVoteLock(gameServerId, moduleId);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ── Vote state ────────────────────────────────────────────────────────────────

export async function getVoteState(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, VOTE_STATE_KEY);
  if (!variable) return null;
  let parsed;
  try {
    parsed = JSON.parse(variable.value);
  } catch (err) {
    console.error(`vote-helpers: failed to parse voteState: ${err}`);
    return null;
  }
  if (!parsed || typeof parsed.status !== 'string' || !Array.isArray(parsed.voters) || !parsed.startedAt) {
    console.error('vote-helpers: voteState is structurally invalid, ignoring');
    return null;
  }
  if (isNaN(new Date(parsed.startedAt).getTime())) {
    console.error('vote-helpers: voteState.startedAt is not a valid date, ignoring');
    return null;
  }
  if (parsed.status === 'passed') {
    if (!parsed.passedAt || isNaN(new Date(parsed.passedAt).getTime())) {
      console.error('vote-helpers: voteState.passedAt is missing or invalid for passed vote, ignoring');
      return null;
    }
  }
  return parsed;
}

export async function setVoteState(gameServerId, moduleId, state) {
  await writeVariable(gameServerId, moduleId, VOTE_STATE_KEY, state);
}

export async function deleteVoteState(gameServerId, moduleId) {
  await removeVariable(gameServerId, moduleId, VOTE_STATE_KEY);
}

export async function getRestartState(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, RESTART_STATE_KEY);
  if (!variable) return null;
  try {
    const parsed = JSON.parse(variable.value);
    if (!parsed?.passedAt || isNaN(new Date(parsed.passedAt).getTime())) return null;
    return parsed;
  } catch (err) {
    console.error(`vote-helpers: failed to parse restartState: ${err}`);
    return null;
  }
}

export async function setRestartState(gameServerId, moduleId, state) {
  await writeVariable(gameServerId, moduleId, RESTART_STATE_KEY, state);
}

export async function deleteRestartState(gameServerId, moduleId) {
  await removeVariable(gameServerId, moduleId, RESTART_STATE_KEY);
}

// ── Cooldown ──────────────────────────────────────────────────────────────────

export async function getCooldownUntil(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, COOLDOWN_KEY);
  if (!variable) return null;
  try {
    return JSON.parse(variable.value);
  } catch (err) {
    console.error(`vote-helpers: failed to parse cooldownUntil: ${err}`);
    return null;
  }
}

export async function setCooldownUntil(gameServerId, moduleId, isoTimestamp) {
  await writeVariable(gameServerId, moduleId, COOLDOWN_KEY, isoTimestamp);
}

export async function deleteCooldown(gameServerId, moduleId) {
  await removeVariable(gameServerId, moduleId, COOLDOWN_KEY);
}

// ── Online non-immune players ─────────────────────────────────────────────────

/**
 * Fetches all online players for this game server, filters out those with
 * the VOTE_RESTART_IMMUNE permission. Returns array of playerOnGameserver records.
 */
export async function getOnlineNonImmunePlayers(gameServerId) {
  let allPlayers = [];
  let page = 0;
  const limit = 100;
  while (true) {
    if (page > 100) break;
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      page,
      limit,
    });
    const batch = res.data.data;
    allPlayers = allPlayers.concat(batch);
    if (allPlayers.length >= res.data.meta.total) break;
    page++;
  }

  return allPlayers.filter((pog) => !checkPermission(pog, 'VOTE_RESTART_IMMUNE'));
}

// ── Threshold math ────────────────────────────────────────────────────────────

/**
 * Compute how many yes votes are needed out of onlineCount players.
 * Always at least 1.
 */
export function computeThreshold(onlineCount, percent) {
  return Math.max(1, Math.ceil(onlineCount * percent / 100));
}

export function getRequiredVotes(voteState, fallbackOnlineCount, percent) {
  return Number(voteState?.requiredVotes ?? computeThreshold(fallbackOnlineCount, percent));
}

export function getEligiblePool(voteState, eligiblePlayers = []) {
  const snapshot = Array.isArray(voteState?.eligiblePlayerIds) && voteState.eligiblePlayerIds.length > 0
    ? voteState.eligiblePlayerIds
    : eligiblePlayers.map((p) => p.playerId);
  return [...new Set(snapshot)];
}

export function getEffectiveVotes(voteState, eligiblePlayers = []) {
  const eligibleIds = new Set(getEligiblePool(voteState, eligiblePlayers));
  return [...new Set(voteState?.voters ?? [])].filter((id) => eligibleIds.has(id)).length;
}
