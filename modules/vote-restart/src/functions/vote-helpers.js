import { takaro, checkPermission } from '@takaro/helpers';

export const VOTE_STATE_KEY = 'vr_vote_state';
export const COOLDOWN_KEY = 'vr_cooldown_until';
export const RESTART_PENDING_KEY = 'vr_restart_pending';
export const RESTART_EXECUTION_LOCK_KEY = 'vr_restart_execution_lock';

const RESTART_EXECUTION_LOCK_TTL_MS = 2 * 60 * 1000;

// ── Generic variable CRUD ─────────────────────────────────────────────────────

function compareVariableRecency(left, right) {
  const leftTimestamp = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
  const rightTimestamp = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }
  return String(right?.id || '').localeCompare(String(left?.id || ''));
}

export async function findVariables(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
    limit: 100,
  });
  return [...res.data.data].sort(compareVariableRecency);
}

export async function findVariable(gameServerId, moduleId, key) {
  const variables = await findVariables(gameServerId, moduleId, key);
  return variables[0] || null;
}

export async function writeVariable(gameServerId, moduleId, key, value) {
  const existing = await findVariables(gameServerId, moduleId, key);
  const serialized = JSON.stringify(value);
  const [primary, ...duplicates] = existing;

  if (primary) {
    try {
      await takaro.variable.variableControllerUpdate(primary.id, { value: serialized });
      await Promise.allSettled(duplicates.map((entry) => takaro.variable.variableControllerDelete(entry.id)));
      return primary.id;
    } catch (err) {
      console.error(`vote-helpers: failed to update variable ${key} primary=${primary.id}, recreating. Error: ${err}`);
      await Promise.allSettled(existing.map((entry) => takaro.variable.variableControllerDelete(entry.id)));
    }
  }

  const created = await takaro.variable.variableControllerCreate({
    key,
    value: serialized,
    gameServerId,
    moduleId,
  });
  return created.data.data.id;
}

export async function removeVariable(gameServerId, moduleId, key) {
  const existing = await findVariables(gameServerId, moduleId, key);
  if (existing.length === 0) {
    return false;
  }
  await Promise.allSettled(existing.map((entry) => takaro.variable.variableControllerDelete(entry.id)));
  return true;
}

function isExpiredExecutionLock(lockValue, ttlMs = RESTART_EXECUTION_LOCK_TTL_MS) {
  const createdAt = new Date(lockValue?.createdAt || 0).getTime();
  if (!createdAt) return true;
  return createdAt + ttlMs <= Date.now();
}

export async function acquireExecutionLock(gameServerId, moduleId, owner = 'restart', retries = 2) {
  const token = `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ token, owner, createdAt: new Date().toISOString() });

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const existing = await findVariable(gameServerId, moduleId, RESTART_EXECUTION_LOCK_KEY);
    if (existing) {
      try {
        const parsed = JSON.parse(existing.value);
        if (isExpiredExecutionLock(parsed)) {
          await takaro.variable.variableControllerDelete(existing.id);
          console.log(`vote-helpers: reaped stale restart execution lock owner=${parsed?.owner || 'unknown'}`);
        } else {
          console.log(`vote-helpers: restart execution lock busy owner=${owner}`);
          return null;
        }
      } catch (parseErr) {
        console.error(`vote-helpers: failed to parse restart execution lock, deleting corrupt value: ${parseErr}`);
        await takaro.variable.variableControllerDelete(existing.id);
      }
      continue;
    }

    try {
      await takaro.variable.variableControllerCreate({
        key: RESTART_EXECUTION_LOCK_KEY,
        value: payload,
        gameServerId,
        moduleId,
      });
    } catch (err) {
      console.log(`vote-helpers: restart execution lock create raced owner=${owner}: ${err}`);
      continue;
    }

    const matches = await findVariables(gameServerId, moduleId, RESTART_EXECUTION_LOCK_KEY);
    const mine = matches.find((entry) => {
      try {
        return JSON.parse(entry.value || '{}').token === token;
      } catch {
        return false;
      }
    });
    const current = matches[0];
    if (mine && current?.id === mine.id) {
      await Promise.allSettled(matches.filter((entry) => entry.id !== mine.id).map((entry) => takaro.variable.variableControllerDelete(entry.id)));
      return token;
    }

    if (mine) {
      await takaro.variable.variableControllerDelete(mine.id);
    }
  }

  return null;
}

export async function releaseExecutionLock(gameServerId, moduleId, token) {
  const existing = await findVariables(gameServerId, moduleId, RESTART_EXECUTION_LOCK_KEY);
  if (existing.length === 0) return;

  if (token) {
    for (const entry of existing) {
      try {
        const parsed = JSON.parse(entry.value || '{}');
        if (parsed?.token === token) {
          await takaro.variable.variableControllerDelete(entry.id);
          return;
        }
      } catch {
        // Best-effort cleanup below.
      }
    }
    return;
  }

  await takaro.variable.variableControllerDelete(existing[0].id);
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

export async function getRestartPending(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, RESTART_PENDING_KEY);
  if (!variable) return null;
  try {
    const parsed = JSON.parse(variable.value);
    if (!parsed || !parsed.passedAt || isNaN(new Date(parsed.passedAt).getTime())) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.error(`vote-helpers: failed to parse restartPending: ${err}`);
    return null;
  }
}

export async function setRestartPending(gameServerId, moduleId, state) {
  await writeVariable(gameServerId, moduleId, RESTART_PENDING_KEY, state);
}

export async function deleteRestartPending(gameServerId, moduleId) {
  await removeVariable(gameServerId, moduleId, RESTART_PENDING_KEY);
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
