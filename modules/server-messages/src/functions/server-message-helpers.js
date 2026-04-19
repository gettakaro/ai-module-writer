import { takaro } from '@takaro/helpers';

export const SERVER_MESSAGES_STATE_KEY = 'server_messages_state';
export const SERVER_MESSAGES_LOCK_KEY = 'server_messages_lock';
export const MAX_MESSAGE_WEIGHT = 100;
const LOCK_RETRY_DELAY_MS = 250;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_TTL_MS = 30000;

export function normalizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];

  return rawMessages
    .filter((message) => message && typeof message.text === 'string' && message.text.length > 0)
    .map((message) => ({
      text: message.text,
      weight: normalizeWeight(message.weight),
    }));
}

export function normalizeWeight(weight) {
  const parsed = Number.isFinite(weight) ? weight : 1;
  const floored = Math.floor(parsed);

  if (floored < 1) return 1;
  if (floored > MAX_MESSAGE_WEIGHT) return MAX_MESSAGE_WEIGHT;
  return floored;
}

export function normalizeOrder(order) {
  return order === 'random' ? 'random' : 'sequential';
}

export function buildConfigFingerprint(order, messages) {
  const normalized = JSON.stringify({
    order: normalizeOrder(order),
    messages: normalizeMessages(messages),
  });

  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `fnv1a:${(hash >>> 0).toString(16)}`;
}

export function createInitialState(fingerprint = '') {
  return {
    fingerprint,
    sequentialIndex: 0,
    bag: [],
    cursor: 0,
  };
}

export function coerceState(rawState) {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return createInitialState();
  }

  const sequentialIndex = Number.isInteger(rawState.sequentialIndex) && rawState.sequentialIndex >= 0
    ? rawState.sequentialIndex
    : 0;
  const bag = Array.isArray(rawState.bag)
    ? rawState.bag.filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  const cursor = Number.isInteger(rawState.cursor) && rawState.cursor >= 0 ? rawState.cursor : 0;
  const fingerprint = typeof rawState.fingerprint === 'string' ? rawState.fingerprint : '';

  return {
    fingerprint,
    sequentialIndex,
    bag,
    cursor,
  };
}

export async function getState(gameServerId, moduleId) {
  const existing = await findVariable(gameServerId, moduleId, SERVER_MESSAGES_STATE_KEY);
  if (!existing) return createInitialState();

  try {
    return coerceState(JSON.parse(existing.value));
  } catch (err) {
    console.error(`server-message-helpers: failed to parse stored state, resetting. Error: ${err}`);
    return createInitialState();
  }
}

export async function setState(gameServerId, moduleId, state) {
  await writeVariable(gameServerId, moduleId, SERVER_MESSAGES_STATE_KEY, state);
}

export async function findVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });

  return res.data.data[0] ?? null;
}

export async function writeVariable(gameServerId, moduleId, key, value) {
  const existing = await findVariable(gameServerId, moduleId, key);
  const serialized = JSON.stringify(value);

  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
    return;
  }

  await takaro.variable.variableControllerCreate({
    key,
    value: serialized,
    gameServerId,
    moduleId,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConflictError(err) {
  return err?.response?.status === 409 || /duplicate key|already exists|unique/i.test(String(err?.message ?? err));
}

export async function acquireExecutionLock(gameServerId, moduleId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : LOCK_TIMEOUT_MS;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : LOCK_RETRY_DELAY_MS;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : LOCK_TTL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await takaro.variable.variableControllerCreate({
        key: SERVER_MESSAGES_LOCK_KEY,
        value: JSON.stringify({ acquiredAt: new Date().toISOString() }),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        gameServerId,
        moduleId,
      });

      return res.data.data;
    } catch (err) {
      if (!isConflictError(err)) throw err;
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`server-message-helpers: timed out acquiring execution lock after ${timeoutMs}ms`);
}

export async function releaseExecutionLock(lockId) {
  if (!lockId) return;

  try {
    await takaro.variable.variableControllerDelete(lockId);
  } catch (err) {
    if (err?.response?.status !== 404) {
      throw err;
    }
  }
}

export function buildWeightedBag(messages) {
  const bag = [];

  for (let index = 0; index < messages.length; index++) {
    const weight = normalizeWeight(messages[index]?.weight);
    for (let count = 0; count < weight; count++) {
      bag.push(index);
    }
  }

  return bag;
}

export function shuffleBag(entries) {
  const shuffled = [...entries];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

export async function getOnlinePlayerCount(gameServerId) {
  const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      online: [true],
    },
    limit: 1,
    page: 0,
  });

  return typeof res.data.meta?.total === 'number' ? res.data.meta.total : res.data.data.length;
}

export async function getServerName(gameServerId) {
  try {
    const res = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
    return res.data.data?.name ?? res.data.name ?? 'Unknown Server';
  } catch (err) {
    console.error(`server-message-helpers: failed to load server name for ${gameServerId}, using fallback. Error: ${err}`);
    return 'Unknown Server';
  }
}

export function renderMessage(template, context) {
  return template.replace(/\{([^{}]+)\}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(context, token)) {
      return String(context[token]);
    }
    return match;
  });
}
