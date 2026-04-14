import { takaro } from '@takaro/helpers';

export const STATE_KEY = 'server_messages_state';
export const FINGERPRINT_KEY = 'server_messages_fingerprint';
export const LOCK_KEY = 'server_messages_lock';
export const DEFAULT_INTERVAL = '*/15 * * * *';
export const MAX_MESSAGES = 100;
export const MAX_WEIGHT = 20;
const LOCK_TIMEOUT_MS = 3 * 60 * 1000;

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
  let stopped = false;

  async function heartbeat() {
    if (stopped) return false;
    return refreshExecutionLock(gameServerId, moduleId, token);
  }

  async function stopHeartbeat() {
    stopped = true;
  }

  return {
    heartbeat,
    stopHeartbeat,
  };
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

export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => message && typeof message.text === 'string')
    .slice(0, MAX_MESSAGES)
    .map((message) => ({
      text: message.text,
      weight: normalizeWeight(message.weight),
    }));
}

export function normalizeOrder(order) {
  return order === 'random' ? 'random' : 'sequential';
}

export function normalizeInterval(interval) {
  if (typeof interval !== 'string') return DEFAULT_INTERVAL;
  const trimmed = interval.trim();
  return trimmed || DEFAULT_INTERVAL;
}

export function normalizeWeight(weight) {
  const parsed = Number(weight);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_WEIGHT);
}

export function computeFingerprint(order, messages) {
  return hashString(JSON.stringify({ order, messages }));
}

export function hashString(input) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

export function getInitialState(order, messages) {
  if (order === 'random') {
    return {
      order: 'random',
      bag: shuffleBag(messages),
      cursor: 0,
    };
  }

  return {
    order: 'sequential',
    index: 0,
  };
}

export function getNextSelection(order, messages, state) {
  if (messages.length === 0) return null;

  if (order === 'random') {
    let workingState = state;
    if (!isValidRandomState(workingState, messages.length, messages)) {
      console.warn('server-message-helpers: random state bag is inconsistent with configured weights, rebuilding');
      workingState = getInitialState(order, messages);
    }

    if (!workingState.bag.length || workingState.cursor >= workingState.bag.length) {
      workingState = getInitialState(order, messages);
    }

    const selectedIndex = workingState.bag[workingState.cursor];
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= messages.length) {
      workingState = getInitialState(order, messages);
    }

    return {
      messageIndex: workingState.bag[workingState.cursor],
      nextState: {
        order: 'random',
        bag: [...workingState.bag],
        cursor: workingState.cursor + 1,
      },
      bagSize: workingState.bag.length,
      cursor: workingState.cursor,
    };
  }

  let index = Number.isInteger(state?.index) ? state.index : 0;
  if (index < 0 || index >= messages.length) index = 0;

  return {
    messageIndex: index,
    nextState: {
      order: 'sequential',
      index: (index + 1) % messages.length,
    },
  };
}

export function renderPlaceholders(text, context) {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (key === 'playerCount') return String(context.playerCount);
    if (key === 'serverName') return context.serverName;
    return match;
  });
}

export function shuffleBag(messages) {
  const bag = [];

  messages.forEach((message, index) => {
    for (let i = 0; i < message.weight; i++) {
      bag.push(index);
    }
  });

  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }

  return bag;
}

export function getIntervalStatus(interval, now = new Date()) {
  const normalized = normalizeInterval(interval);
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, matches: false, normalized };
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  const minuteMatches = matchesCronField(minuteField, now.getUTCMinutes(), 0, 59);
  const hourMatches = matchesCronField(hourField, now.getUTCHours(), 0, 23);
  const monthMatches = matchesCronField(monthField, now.getUTCMonth() + 1, 1, 12);
  const dayOfMonthMatches = matchesCronField(dayOfMonthField, now.getUTCDate(), 1, 31);
  const dayOfWeekMatches = matchesCronField(dayOfWeekField, now.getUTCDay(), 0, 7, { normalizeDayOfWeek: true });

  if (
    minuteMatches === null ||
    hourMatches === null ||
    monthMatches === null ||
    dayOfMonthMatches === null ||
    dayOfWeekMatches === null
  ) {
    return { valid: false, matches: false, normalized };
  }

  const daysMatch = getDayMatchStatus(dayOfMonthField, dayOfMonthMatches, dayOfWeekField, dayOfWeekMatches);

  return {
    valid: true,
    matches: minuteMatches && hourMatches && monthMatches && daysMatch,
    normalized,
  };
}

function getDayMatchStatus(dayOfMonthField, dayOfMonthMatches, dayOfWeekField, dayOfWeekMatches) {
  const dayOfMonthIsWildcard = isWildcardField(dayOfMonthField);
  const dayOfWeekIsWildcard = isWildcardField(dayOfWeekField);

  if (dayOfMonthIsWildcard && dayOfWeekIsWildcard) return true;
  if (dayOfMonthIsWildcard) return dayOfWeekMatches;
  if (dayOfWeekIsWildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function isWildcardField(field) {
  return field.trim() === '*';
}

function matchesCronField(field, value, min, max, options = {}) {
  const allowedValues = parseCronField(field, min, max, options);
  if (!allowedValues) return null;
  return allowedValues.has(value);
}

function parseCronField(field, min, max, options = {}) {
  const segments = field.split(',').map((segment) => segment.trim());
  if (segments.length === 0 || segments.some((segment) => !segment)) return null;

  const allowedValues = new Set();

  for (const segment of segments) {
    const segmentValues = parseCronSegmentValues(segment, min, max, options);
    if (!segmentValues) return null;

    for (const entry of segmentValues) {
      allowedValues.add(entry);
    }
  }

  return allowedValues;
}

function parseCronSegmentValues(segment, min, max, options = {}) {
  if (!segment) return null;

  const stepParts = segment.split('/');
  if (stepParts.length > 2) return null;

  const [base, rawStep] = stepParts;
  const step = rawStep === undefined ? 1 : parseCronNumberToken(rawStep);
  if (!Number.isInteger(step) || step < 1 || step > max) return null;

  if (base === '*') {
    return buildCronValueSet(min, max, min, max, step, options);
  }

  if (base.includes('-')) {
    const rangeParts = base.split('-');
    if (rangeParts.length !== 2) return null;

    const [startRaw, endRaw] = rangeParts;
    const start = parseCronNumberToken(startRaw);
    const end = parseCronNumberToken(endRaw);
    if (!isAllowedCronNumber(start, min, max, options) || !isAllowedCronNumber(end, min, max, options)) {
      return null;
    }
    if (start >= end) return null;

    return buildCronValueSet(start, end, min, max, step, options);
  }

  if (rawStep !== undefined) return null;

  const exact = parseCronNumberToken(base);
  if (!isAllowedCronNumber(exact, min, max, options)) return null;
  return new Set([normalizeCronValue(exact, options)]);
}

function parseCronNumberToken(token) {
  if (!/^\d+$/.test(token)) return Number.NaN;
  if (token.length > 1 && token.startsWith('0')) return Number.NaN;
  return Number(token);
}

function buildCronValueSet(start, end, min, max, step, options = {}) {
  const values = new Set();

  for (let current = start; current <= end; current += step) {
    if (!isAllowedCronNumber(current, min, max, options)) return null;
    values.add(normalizeCronValue(current, options));
  }

  return values;
}

function isAllowedCronNumber(value, min, max, options = {}) {
  if (!Number.isInteger(value)) return false;
  if (options.normalizeDayOfWeek && value === 7) return true;
  return value >= min && value <= max;
}

function normalizeCronValue(value, options = {}) {
  if (options.normalizeDayOfWeek && value === 7) return 0;
  return value;
}

function isValidRandomState(state, messageCount, messages) {
  if (!state || state.order !== 'random') return false;
  if (!Array.isArray(state.bag)) return false;
  if (!Number.isInteger(state.cursor) || state.cursor < 0) return false;
  if (state.cursor > state.bag.length) return false;

  const expectedCounts = new Array(messageCount).fill(0);
  for (let index = 0; index < messages.length; index++) {
    expectedCounts[index] = messages[index].weight;
  }

  const actualCounts = new Array(messageCount).fill(0);
  for (const entry of state.bag) {
    if (!Number.isInteger(entry) || entry < 0 || entry >= messageCount) return false;
    actualCounts[entry] += 1;
  }

  if (state.bag.length !== expectedCounts.reduce((sum, count) => sum + count, 0)) {
    return false;
  }

  return actualCounts.every((count, index) => count === expectedCounts[index]);
}
