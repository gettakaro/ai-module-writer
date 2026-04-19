import { takaro } from '@takaro/helpers';

export const FUND_TOTAL_KEY = 'fund_total';
// Internally called 'cycle' in storage keys; displayed as 'Round' to players.
export const FUND_CYCLE_KEY = 'fund_cycle';
export const FUND_LAST_COMPLETION_KEY = 'fund_last_completion';
export const FUND_STATE_LOCK_KEY = 'fund_state_lock';

function wait(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Takaro's function sandbox does not expose timer APIs like setTimeout.
    // A short synchronous pause is enough for lock contention backoff here.
  }
}

function isConflictError(err) {
  const status = err?.response?.status ?? err?.status;
  const message = String(err?.message ?? err ?? '');
  return status === 409 || message.includes('409') || message.toLowerCase().includes('conflict');
}

function parseLockValue(variable) {
  if (!variable) return null;

  try {
    const parsed = JSON.parse(variable.value);
    const owner = typeof parsed?.owner === 'string' ? parsed.owner : '';
    const createdAt = typeof parsed?.createdAt === 'number' ? parsed.createdAt : 0;
    if (!owner || !createdAt) return null;
    return { owner, createdAt };
  } catch {
    return null;
  }
}

/**
 * Generic variable read helper. Returns the variable record or null if not found.
 */
export async function getFundVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

/**
 * Generic variable write helper. Creates if not existing, updates if existing.
 */
export async function setFundVariable(gameServerId, moduleId, key, value) {
  const existing = await getFundVariable(gameServerId, moduleId, key);
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

export async function acquireFundStateLock(
  gameServerId,
  moduleId,
  owner,
  { maxWaitMs = 5000, pollMs = 200, staleAfterMs = 15000 } = {},
) {
  const deadline = Date.now() + maxWaitMs;
  const lockValue = {
    owner,
    createdAt: Date.now(),
  };

  while (Date.now() < deadline) {
    try {
      await takaro.variable.variableControllerCreate({
        key: FUND_STATE_LOCK_KEY,
        value: JSON.stringify(lockValue),
        gameServerId,
        moduleId,
      });
      return lockValue;
    } catch (err) {
      if (!isConflictError(err)) {
        throw err;
      }

      const existing = await getFundVariable(gameServerId, moduleId, FUND_STATE_LOCK_KEY);
      const parsed = parseLockValue(existing);
      const ageMs = parsed ? Date.now() - parsed.createdAt : Infinity;

      if (existing && ageMs > staleAfterMs) {
        try {
          await takaro.variable.variableControllerDelete(existing.id);
          console.warn(`fund-helpers: removed stale fund lock owned by ${parsed?.owner ?? 'unknown'} after ${ageMs}ms`);
          continue;
        } catch (deleteErr) {
          console.warn(`fund-helpers: failed to delete stale fund lock: ${deleteErr}`);
        }
      }

      wait(pollMs);
    }
  }

  throw new Error('Timed out acquiring the community fund state lock');
}

export async function releaseFundStateLock(gameServerId, moduleId, owner) {
  const existing = await getFundVariable(gameServerId, moduleId, FUND_STATE_LOCK_KEY);
  if (!existing) return false;

  const parsed = parseLockValue(existing);
  if (parsed && parsed.owner && parsed.owner !== owner) {
    return false;
  }

  await takaro.variable.variableControllerDelete(existing.id);
  return true;
}

/**
 * Get the current fund total (numeric integer). Returns 0 if not set or if data is corrupt.
 */
export async function getFundTotal(gameServerId, moduleId) {
  const variable = await getFundVariable(gameServerId, moduleId, FUND_TOTAL_KEY);
  if (!variable) return 0;
  try {
    const val = Math.floor(JSON.parse(variable.value));
    return isNaN(val) ? 0 : val;
  } catch (err) {
    console.error(`fund-helpers: getFundTotal failed to parse stored value, resetting to 0. Error: ${err}`);
    return 0;
  }
}

/**
 * Set the fund total. Coerces non-numeric or NaN values to 0.
 */
export async function setFundTotal(gameServerId, moduleId, total) {
  if (typeof total !== 'number' || isNaN(total)) total = 0;
  await setFundVariable(gameServerId, moduleId, FUND_TOTAL_KEY, total);
}

/**
 * Get the current fund cycle count (number of completions). Returns 0 if not set or if data is corrupt.
 */
export async function getFundCycle(gameServerId, moduleId) {
  const variable = await getFundVariable(gameServerId, moduleId, FUND_CYCLE_KEY);
  if (!variable) return 0;
  try {
    const val = Math.floor(JSON.parse(variable.value));
    return isNaN(val) ? 0 : val;
  } catch (err) {
    console.error(`fund-helpers: getFundCycle failed to parse stored value, resetting to 0. Error: ${err}`);
    return 0;
  }
}

/**
 * Increment the fund cycle count by 1.
 */
export async function incrementFundCycle(gameServerId, moduleId) {
  const current = await getFundCycle(gameServerId, moduleId);
  const next = current + 1;
  await setFundVariable(gameServerId, moduleId, FUND_CYCLE_KEY, next);
  return next;
}

/**
 * Record completion metadata (cycle number, timestamp, triggering player name).
 */
export async function recordCompletion(gameServerId, moduleId, cycle, triggerPlayer) {
  const completion = {
    cycle,
    // ISO date only (YYYY-MM-DD) — avoids locale-dependent formatting and excessive precision
    completedAt: new Date().toISOString().split('T')[0],
    triggerPlayer,
  };
  await setFundVariable(gameServerId, moduleId, FUND_LAST_COMPLETION_KEY, completion);
}
