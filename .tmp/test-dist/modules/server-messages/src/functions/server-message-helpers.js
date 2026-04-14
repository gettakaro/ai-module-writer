import { takaro } from '@takaro/helpers';
import {
  computeFingerprint,
  createExecutionLockHeartbeat,
  DEFAULT_INTERVAL,
  DEFAULT_TIME_ZONE,
  findUnknownPlaceholders,
  getInitialState,
  getIntervalStatus,
  getNextSelection,
  isValidTimeZone,
  MAX_MESSAGES,
  MAX_WEIGHT,
  normalizeInterval,
  normalizeMessages,
  normalizeOrder,
  normalizeTimeZone,
  renderPlaceholders,
  SUPPORTED_PLACEHOLDERS,
} from './server-message-utils.js';

export {
  computeFingerprint,
  createExecutionLockHeartbeat,
  DEFAULT_INTERVAL,
  DEFAULT_TIME_ZONE,
  findUnknownPlaceholders,
  getInitialState,
  getIntervalStatus,
  getNextSelection,
  isValidTimeZone,
  MAX_MESSAGES,
  MAX_WEIGHT,
  normalizeInterval,
  normalizeMessages,
  normalizeOrder,
  normalizeTimeZone,
  renderPlaceholders,
  SUPPORTED_PLACEHOLDERS,
};

export const STATE_KEY = 'server_messages_state';
export const FINGERPRINT_KEY = 'server_messages_fingerprint';
export const LOCK_KEY = 'server_messages_lock';
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;

async function findVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });

  return res.data.data[0] ?? null;
}

async function upsertVariable(gameServerId, moduleId, key, value) {
  const existing = await findVariable(gameServerId, moduleId, key);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value });
    return;
  }

  await takaro.variable.variableControllerCreate({
    key,
    value,
    gameServerId,
    moduleId,
  });
}

export async function acquireExecutionLock(gameServerId, moduleId) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    await takaro.variable.variableControllerCreate({
      key: LOCK_KEY,
      value: token,
      gameServerId,
      moduleId,
      expiresAt: new Date(Date.now() + LOCK_TIMEOUT_MS).toISOString(),
    });
    return token;
  } catch (err) {
    const message = String(err?.message ?? err).toLowerCase();
    const status = err?.response?.status;
    const isLockContention =
      status === 409 || message.includes('409') || message.includes('duplicate') || message.includes('unique');

    if (isLockContention) {
      return null;
    }

    throw err;
  }
}

export async function refreshExecutionLock(gameServerId, moduleId, token) {
  const variable = await findVariable(gameServerId, moduleId, LOCK_KEY);
  if (!variable || variable.value !== token) return false;

  await takaro.variable.variableControllerUpdate(variable.id, {
    value: token,
    expiresAt: new Date(Date.now() + LOCK_TIMEOUT_MS).toISOString(),
  });
  return true;
}

export function startExecutionLockHeartbeat(gameServerId, moduleId, token) {
  return createExecutionLockHeartbeat(() => refreshExecutionLock(gameServerId, moduleId, token));
}

export async function releaseExecutionLock(gameServerId, moduleId, token) {
  const variable = await findVariable(gameServerId, moduleId, LOCK_KEY);
  if (!variable || variable.value !== token) return;
  await takaro.variable.variableControllerDelete(variable.id);
}

export async function getFingerprint(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, FINGERPRINT_KEY);
  return variable ? variable.value : null;
}

export async function setFingerprint(gameServerId, moduleId, fingerprint) {
  await upsertVariable(gameServerId, moduleId, FINGERPRINT_KEY, fingerprint);
}

export async function getState(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, STATE_KEY);
  if (!variable) return null;

  try {
    return JSON.parse(variable.value);
  } catch (err) {
    console.error(`server-message-helpers: failed to parse state, resetting. Error: ${err}`);
    return null;
  }
}

export async function setState(gameServerId, moduleId, state) {
  await upsertVariable(gameServerId, moduleId, STATE_KEY, JSON.stringify(state));
}
