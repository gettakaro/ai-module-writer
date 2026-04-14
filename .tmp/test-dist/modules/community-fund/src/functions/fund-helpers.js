import { takaro } from '@takaro/helpers';

export const FUND_TOTAL_KEY = 'fund_total';
// Internally called 'cycle' in storage keys; displayed as 'Round' to players.
export const FUND_CYCLE_KEY = 'fund_cycle';
export const FUND_LAST_COMPLETION_KEY = 'fund_last_completion';

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
