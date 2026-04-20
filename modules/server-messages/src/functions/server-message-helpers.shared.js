export const SERVER_MESSAGES_STATE_KEY = 'server_messages_state';
export const SERVER_MESSAGES_LOCK_KEY = 'server_messages_lock';
export const SERVER_MESSAGES_DELIVERY_RECEIPT_KEY = 'server_messages_delivery_receipt';
export const MAX_MESSAGE_WEIGHT = 100;
export const MAX_MESSAGE_COUNT = 100;
const SUPPORTED_PLACEHOLDERS = ['playerCount', 'serverName'];
const SERVER_NAME_FALLBACK = '{serverName}';

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
