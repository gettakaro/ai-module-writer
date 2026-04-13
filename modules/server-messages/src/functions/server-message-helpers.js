import { takaro } from '@takaro/helpers';

export const STATE_KEY = 'server_messages_state';
export const FINGERPRINT_KEY = 'server_messages_fingerprint';

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
    .map((message) => ({
      text: message.text,
      weight: normalizeWeight(message.weight),
    }));
}

export function normalizeOrder(order) {
  return order === 'random' ? 'random' : 'sequential';
}

export function normalizeWeight(weight) {
  const parsed = Number(weight);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return 1;
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
    if (!isValidRandomState(workingState, messages.length)) {
      workingState = getInitialState(order, messages);
    }

    if (!workingState.bag.length || workingState.cursor >= workingState.bag.length) {
      workingState = getInitialState(order, messages);
    }

    const messageIndex = workingState.bag[workingState.cursor];
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= messages.length) {
      workingState = getInitialState(order, messages);
    }

    const selectedIndex = workingState.bag[workingState.cursor];
    return {
      messageIndex: selectedIndex,
      nextState: {
        order: 'random',
        bag: [...workingState.bag],
        cursor: workingState.cursor + 1,
      },
      bag: [...workingState.bag],
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

function isValidRandomState(state, messageCount) {
  if (!state || state.order !== 'random') return false;
  if (!Array.isArray(state.bag)) return false;
  if (!Number.isInteger(state.cursor) || state.cursor < 0) return false;

  return state.bag.every((entry) => Number.isInteger(entry) && entry >= 0 && entry < messageCount);
}
