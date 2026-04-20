import { takaro } from '@takaro/helpers';

export const FUND_DEBUG_FORCE_STATE_WRITE_FAILURE_KEY = '__debug_force_state_write_failure_after_deduct';
export const FUND_DEBUG_FORCE_REFUND_FAILURE_KEY = '__debug_force_refund_failure_after_state_write_failure';
export const FUND_DEBUG_FORCE_STATE_RESTORE_FAILURE_KEY = '__debug_force_state_restore_failure_after_refund';
export const FUND_DEBUG_REPLACE_LOCK_OWNER_KEY = '__debug_replace_lock_owner_before_release';

export const FUND_TOTAL_KEY = 'fund_total';
// Internally called 'cycle' in storage keys; displayed as 'Round' to players.
export const FUND_CYCLE_KEY = 'fund_cycle';
export const FUND_LAST_COMPLETION_KEY = 'fund_last_completion';
export const FUND_STATE_LOCK_KEY = 'fund_state_lock';

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
    const refreshedAt = typeof parsed?.refreshedAt === 'number'
      ? parsed.refreshedAt
      : (typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : createdAt);
    if (!owner || !createdAt || !refreshedAt) return null;
    return { owner, createdAt, refreshedAt };
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
  { maxWaitMs = 45000, pollMs = 200, staleAfterMs = 120000, inactiveLockFailMs = maxWaitMs } = {},
) {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  const retryBudgetMs = Math.max(1, pollMs);
  let lastObservedOwner = '';
  let lastObservedRefresh = 0;
  let unchangedSince = 0;

  while (Date.now() <= deadline) {
    const now = Date.now();
    const lockValue = {
      owner,
      createdAt: now,
      refreshedAt: now,
    };

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
      const ageMs = parsed ? Date.now() - parsed.refreshedAt : Infinity;

      if (existing && ageMs > staleAfterMs) {
        try {
          await takaro.variable.variableControllerDelete(existing.id);
          console.warn(`fund-helpers: removed stale fund lock owned by ${parsed?.owner ?? 'unknown'} after ${ageMs}ms`);
          unchangedSince = 0;
          lastObservedOwner = '';
          lastObservedRefresh = 0;
          continue;
        } catch (deleteErr) {
          console.warn(`fund-helpers: failed to delete stale fund lock: ${deleteErr}`);
        }
      }

      const observedOwner = parsed?.owner ?? 'unknown';
      const observedRefresh = parsed?.refreshedAt ?? 0;
      if (observedOwner === lastObservedOwner && observedRefresh === lastObservedRefresh) {
        unchangedSince = unchangedSince || Date.now();
        if (Date.now() - unchangedSince >= Math.max(maxWaitMs, inactiveLockFailMs)) {
          throw new Error('Timed out acquiring the community fund state lock');
        }
      } else {
        lastObservedOwner = observedOwner;
        lastObservedRefresh = observedRefresh;
        unchangedSince = Date.now();
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    // Takaro's function sandbox does not expose setTimeout(). The API round-trips in
    // this loop already provide back-pressure, so keep retrying until the deadline
    // instead of crashing the retry path with ReferenceError.
    if (remainingMs > retryBudgetMs) {
      await getFundVariable(gameServerId, moduleId, FUND_STATE_LOCK_KEY);
    }
  }

  throw new Error('Timed out acquiring the community fund state lock');
}

export async function refreshFundStateLock(gameServerId, moduleId, owner) {
  const existing = await getFundVariable(gameServerId, moduleId, FUND_STATE_LOCK_KEY);
  if (!existing) return false;

  const parsed = parseLockValue(existing);
  if (!parsed || parsed.owner !== owner) {
    return false;
  }

  await takaro.variable.variableControllerUpdate(existing.id, {
    value: JSON.stringify({
      owner,
      createdAt: parsed.createdAt,
      refreshedAt: Date.now(),
    }),
  });
  return true;
}

export async function assertFundStateLock(gameServerId, moduleId, owner) {
  const stillOwned = await refreshFundStateLock(gameServerId, moduleId, owner);
  if (!stillOwned) {
    throw new Error('Community fund contribution lost its state lock before the operation could finish');
  }
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
    completedAt: new Date().toISOString(),
    triggerPlayer,
  };
  await setFundVariable(gameServerId, moduleId, FUND_LAST_COMPLETION_KEY, completion);
}

export async function consumeFundDebugFlag(gameServerId, moduleId, key) {
  const variable = await getFundVariable(gameServerId, moduleId, key);
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
    console.warn(`fund-helpers: failed to delete debug flag ${key}: ${err}`);
  }

  return enabled;
}
