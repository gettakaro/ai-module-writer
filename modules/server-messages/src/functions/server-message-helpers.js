import { takaro } from '@takaro/helpers';

export const SERVER_MESSAGES_STATE_KEY = 'server_messages_state';
export const SERVER_MESSAGES_LOCK_KEY = 'server_messages_lock';
export const SERVER_MESSAGES_DELIVERY_RECEIPT_KEY = 'server_messages_delivery_receipt';
export const MAX_MESSAGE_WEIGHT = 100;
export const MAX_MESSAGE_COUNT = 100;
const SUPPORTED_PLACEHOLDERS = ['playerCount', 'serverName'];
const SERVER_NAME_FALLBACK = 'Unknown server';
const TEST_FORCE_STATE_WRITE_FAILURE_KEY = 'server_messages_test_force_state_write_failure';
const TEST_FORCE_RECEIPT_WRITE_FAILURE_KEY = 'server_messages_test_force_receipt_write_failure';
const LOCK_TTL_MS = 30000;
const LOCK_TIMEOUT_MS = LOCK_TTL_MS + 5000;
const LOCK_RETRY_DELAY_MS = 250;
const PLAYER_COUNT_PAGE_SIZE = 100;
const MAX_PLAYER_COUNT_PAGES = 100;

export function normalizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];

  return rawMessages
    .slice(0, MAX_MESSAGE_COUNT)
    .filter((message) => message && typeof message.text === 'string' && message.text.trim().length > 0)
    .map((message) => ({
      text: message.text,
      weight: normalizeWeight(message.weight),
    }));
}

export function normalizeWeight(weight) {
  if (weight === undefined || weight === null) {
    return 1;
  }

  const parsed = Number(weight);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`server-message-helpers: weight '${weight}' must be an integer between 1 and ${MAX_MESSAGE_WEIGHT}`);
  }

  if (parsed < 1 || parsed > MAX_MESSAGE_WEIGHT) {
    throw new Error(`server-message-helpers: weight '${weight}' must be between 1 and ${MAX_MESSAGE_WEIGHT}`);
  }

  return parsed;
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

export function getServerNameFallback() {
  return SERVER_NAME_FALLBACK;
}

export function renderMessage(template, context) {
  const unknownTokens = new Set();
  const unavailableTokens = new Set();

  const rendered = template.replace(/\{([^{}]+)\}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(context, token)) {
      const value = context[token];
      if (value === '' || value === null || value === undefined) {
        unavailableTokens.add(token);
        return match;
      }

      return String(value);
    }

    unknownTokens.add(token);
    return match;
  });

  if (unknownTokens.size > 0) {
    console.warn(
      `server-message-helpers: left unknown placeholders unchanged [${[...unknownTokens].join(', ')}]; supported placeholders: ${SUPPORTED_PLACEHOLDERS.join(', ')}`,
    );
  }

  if (unavailableTokens.size > 0) {
    console.warn(
      `server-message-helpers: left unavailable placeholders unchanged [${[...unavailableTokens].join(', ')}] because runtime values were blank or missing`,
    );
  }

  return rendered;
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
  await maybeThrowForcedWriteFailure(gameServerId, moduleId, TEST_FORCE_STATE_WRITE_FAILURE_KEY, 'state persistence');
  await writeVariable(gameServerId, moduleId, SERVER_MESSAGES_STATE_KEY, state);
}

export async function getDeliveryReceipt(gameServerId, moduleId) {
  const existing = await findVariable(gameServerId, moduleId, SERVER_MESSAGES_DELIVERY_RECEIPT_KEY);
  if (!existing) return null;

  try {
    return {
      variableId: existing.id,
      value: JSON.parse(existing.value),
    };
  } catch (err) {
    console.error(`server-message-helpers: failed to parse stored delivery receipt, discarding. Error: ${err}`);
    await deleteVariable(existing.id);
    return null;
  }
}

export async function setDeliveryReceipt(gameServerId, moduleId, receipt) {
  await maybeThrowForcedWriteFailure(gameServerId, moduleId, TEST_FORCE_RECEIPT_WRITE_FAILURE_KEY, 'delivery receipt persistence');
  await writeVariable(gameServerId, moduleId, SERVER_MESSAGES_DELIVERY_RECEIPT_KEY, receipt);
}

export async function clearDeliveryReceipt(gameServerId, moduleId) {
  const existing = await findVariable(gameServerId, moduleId, SERVER_MESSAGES_DELIVERY_RECEIPT_KEY);
  if (!existing) return;
  await deleteVariable(existing.id);
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

async function maybeThrowForcedWriteFailure(gameServerId, moduleId, key, label) {
  const injectedFailure = await findVariable(gameServerId, moduleId, key);
  if (!injectedFailure) return;

  await tryDeleteVariable(injectedFailure.id);
  throw new Error(`server-message-helpers: forced ${label} failure for testing`);
}

export async function writeVariable(gameServerId, moduleId, key, value) {
  const serialized = JSON.stringify(value);

  while (true) {
    const existing = await findVariable(gameServerId, moduleId, key);

    if (existing) {
      try {
        await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
        return;
      } catch (err) {
        if (err?.response?.status === 404) {
          continue;
        }
        throw err;
      }
    }

    try {
      await takaro.variable.variableControllerCreate({
        key,
        value: serialized,
        gameServerId,
        moduleId,
      });
      return;
    } catch (err) {
      if (isConflictError(err)) {
        continue;
      }
      throw err;
    }
  }
}

function isConflictError(err) {
  return err?.response?.status === 409 || /duplicate key|already exists|unique/i.test(String(err?.message ?? err));
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isNaN(timestamp) ? null : timestamp;
}

function parseLockExpiryMs(lockVariable, ttlMs) {
  const explicitExpiry = parseTimestamp(lockVariable?.expiresAt);
  if (explicitExpiry !== null) return explicitExpiry;

  try {
    const parsedValue = JSON.parse(lockVariable?.value ?? '{}');
    const acquiredAt = parseTimestamp(parsedValue?.acquiredAt);
    if (acquiredAt !== null) return acquiredAt + ttlMs;
  } catch {
    // Ignore malformed lock payloads and treat them as stale below.
  }

  return null;
}

function isLockStale(lockVariable, ttlMs, now = Date.now()) {
  const expiryMs = parseLockExpiryMs(lockVariable, ttlMs);
  if (expiryMs === null) return true;
  return expiryMs <= now;
}

async function deleteVariable(variableId) {
  await takaro.variable.variableControllerDelete(variableId);
}

async function tryDeleteVariable(variableId) {
  try {
    await takaro.variable.variableControllerDelete(variableId);
    return true;
  } catch (err) {
    if (err?.response?.status === 404) {
      return false;
    }
    throw err;
  }
}

function createLockToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

async function waitForNextLockAttempt(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }

  if (typeof setTimeout === 'function') {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }

  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    await Promise.resolve();
  }
}

function buildLockPayload(token, now = new Date()) {
  return {
    token,
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
  };
}

function parseLockPayload(lockVariable) {
  try {
    const parsedValue = JSON.parse(lockVariable?.value ?? '{}');
    return parsedValue && typeof parsedValue === 'object' ? parsedValue : {};
  } catch {
    return {};
  }
}

function getLockToken(lockVariable) {
  const payload = parseLockPayload(lockVariable);
  return typeof payload.token === 'string' && payload.token.length > 0 ? payload.token : null;
}

async function refreshExecutionLock(lock, ttlMs) {
  const existingLock = await findVariable(lock.gameServerId, lock.moduleId, SERVER_MESSAGES_LOCK_KEY);
  if (!existingLock || existingLock.id !== lock.id) {
    throw new Error(`server-message-helpers: execution lock ${lock.id} disappeared during heartbeat`);
  }

  const currentToken = getLockToken(existingLock);
  if (currentToken !== lock.token) {
    throw new Error(`server-message-helpers: execution lock ${lock.id} ownership changed during heartbeat`);
  }

  const now = new Date();
  await takaro.variable.variableControllerUpdate(lock.id, {
    value: JSON.stringify(buildLockPayload(lock.token, now)),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function startExecutionLockHeartbeat(lock, options = {}) {
  if (!lock?.id || !lock?.token) {
    return {
      beat: async () => {},
      stop: async () => {},
    };
  }

  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : LOCK_TTL_MS;
  const intervalMs = Number.isFinite(options.intervalMs)
    ? options.intervalMs
    : Math.max(1000, Math.floor(ttlMs / 3));
  let stopped = false;
  let inFlightBeat = Promise.resolve();
  let lastError = null;
  let timer = null;

  const beatOnce = async (label = 'checkpoint') => {
    if (stopped) return;
    if (lastError) throw lastError;

    try {
      await refreshExecutionLock(lock, ttlMs);
      console.log(`server-message-helpers: refreshed execution lock heartbeat at ${label}`);
    } catch (err) {
      lastError = new Error(`server-message-helpers: execution lock heartbeat failed at ${label}: ${err}`);
      throw lastError;
    }
  };

  const queueBeat = (label = 'checkpoint') => {
    if (stopped || lastError) return inFlightBeat;
    inFlightBeat = inFlightBeat.then(() => beatOnce(label));
    return inFlightBeat;
  };

  const clearTimer = () => {
    if (timer !== null && typeof clearTimeout === 'function') {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleNextBeat = () => {
    if (stopped || lastError || typeof setTimeout !== 'function' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      queueBeat('interval').catch(() => {
        // stop() rethrows the normalized error.
      }).finally(() => {
        scheduleNextBeat();
      });
    }, intervalMs);

    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
  };

  scheduleNextBeat();

  return {
    beat: async (label = 'checkpoint') => queueBeat(label),
    stop: async () => {
      stopped = true;
      clearTimer();

      try {
        await inFlightBeat;
      } catch {
        // Re-throw the normalized heartbeat error below.
      }

      if (lastError) {
        throw lastError;
      }
    },
  };
}

export async function acquireExecutionLock(gameServerId, moduleId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : LOCK_TIMEOUT_MS;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : LOCK_TTL_MS;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : LOCK_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let observedExpiredLockWhileWaiting = false;
  let waitedForHealthyLockExpiry = false;

  while (Date.now() < deadline) {
    const token = createLockToken();
    const now = new Date();

    try {
      const res = await takaro.variable.variableControllerCreate({
        key: SERVER_MESSAGES_LOCK_KEY,
        value: JSON.stringify(buildLockPayload(token, now)),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        gameServerId,
        moduleId,
      });

      if (observedExpiredLockWhileWaiting || waitedForHealthyLockExpiry) {
        console.warn('server-message-helpers: cleared stale execution lock after waiting for expiry');
      }

      return {
        ...res.data.data,
        token,
        gameServerId,
        moduleId,
      };
    } catch (err) {
      if (!isConflictError(err)) throw err;

      const existingLock = await findVariable(gameServerId, moduleId, SERVER_MESSAGES_LOCK_KEY);
      const nowMs = Date.now();
      if (existingLock?.id) {
        if (isLockStale(existingLock, ttlMs, nowMs)) {
          const deleted = await tryDeleteVariable(existingLock.id);
          if (deleted) {
            console.warn(`server-message-helpers: cleared stale execution lock ${existingLock.id}`);
          }
          observedExpiredLockWhileWaiting = true;
          continue;
        }

        const expiryMs = parseLockExpiryMs(existingLock, ttlMs);
        const remainingMs = expiryMs === null ? retryDelayMs : Math.max(0, expiryMs - nowMs);
        const nextPollMs = remainingMs === 0 ? retryDelayMs : Math.min(remainingMs, retryDelayMs);
        const waitMs = Math.min(nextPollMs, Math.max(0, deadline - nowMs));
        waitedForHealthyLockExpiry = true;
        if (remainingMs <= retryDelayMs) {
          observedExpiredLockWhileWaiting = true;
        }
        await waitForNextLockAttempt(waitMs);
        continue;
      }

      observedExpiredLockWhileWaiting = true;
      const nowBeforeRetry = Date.now();
      await waitForNextLockAttempt(Math.min(retryDelayMs, Math.max(0, deadline - nowBeforeRetry)));
    }
  }

  throw new Error(`server-message-helpers: timed out acquiring execution lock after ${timeoutMs}ms`);
}

export async function releaseExecutionLock(lock) {
  if (!lock?.id) return;

  try {
    if (lock.token) {
      const existingLock = await findVariable(lock.gameServerId, lock.moduleId, SERVER_MESSAGES_LOCK_KEY);
      const currentToken = existingLock ? getLockToken(existingLock) : null;
      if (!existingLock || existingLock.id !== lock.id || currentToken !== lock.token) {
        console.warn(`server-message-helpers: skipping release for lock ${lock.id} because ownership changed`);
        return;
      }
    }

    await takaro.variable.variableControllerDelete(lock.id);
  } catch (err) {
    if (err?.response?.status !== 404) {
      throw err;
    }
  }
}

export async function getOnlinePlayerCount(gameServerId) {
  let countedPlayers = 0;

  for (let page = 0; page < MAX_PLAYER_COUNT_PAGES; page++) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      limit: PLAYER_COUNT_PAGE_SIZE,
      page,
    });

    if (typeof res.data.meta?.total === 'number') {
      return res.data.meta.total;
    }

    countedPlayers += res.data.data.length;
    if (res.data.data.length < PLAYER_COUNT_PAGE_SIZE) {
      return countedPlayers;
    }
  }

  console.warn(`server-message-helpers: player count exceeded ${MAX_PLAYER_COUNT_PAGES} pages without meta.total; returning partial count ${countedPlayers}`);
  return countedPlayers;
}

export async function getServerName(gameServerId) {
  try {
    const res = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
    const serverName = String(res.data.data?.name ?? res.data.name ?? '').trim();
    if (serverName.length > 0) {
      return serverName;
    }

    console.warn(
      `server-message-helpers: server name for ${gameServerId} was blank; using fallback '${getServerNameFallback()}' instead of leaving {serverName} in chat`,
    );
    return getServerNameFallback();
  } catch (err) {
    console.error(
      `server-message-helpers: failed to load server name for ${gameServerId}; using fallback '${getServerNameFallback()}'. Error: ${err}`,
    );
    return getServerNameFallback();
  }
}
