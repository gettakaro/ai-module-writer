import { takaro, checkPermission } from '@takaro/helpers';

export const VOTE_STATE_KEY = 'vr_vote_state';
export const COOLDOWN_KEY = 'vr_cooldown_until';

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
