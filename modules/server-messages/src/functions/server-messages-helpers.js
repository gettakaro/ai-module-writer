import { takaro } from '@takaro/helpers';

export const SERVER_MESSAGES_INDEX_KEY = 'server_messages_index';

async function findVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });

  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export async function getMessageIndex(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, SERVER_MESSAGES_INDEX_KEY);
  if (!variable) return 0;

  try {
    const parsed = Math.floor(JSON.parse(variable.value));
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  } catch (err) {
    console.error(`server-messages-helpers: failed to parse stored message index, defaulting to 0. Error: ${err}`);
    return 0;
  }
}

export async function setMessageIndex(gameServerId, moduleId, index) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const serialized = JSON.stringify(safeIndex);
  const existing = await findVariable(gameServerId, moduleId, SERVER_MESSAGES_INDEX_KEY);

  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    await takaro.variable.variableControllerCreate({
      key: SERVER_MESSAGES_INDEX_KEY,
      value: serialized,
      gameServerId,
      moduleId,
    });
  }
}

export function resolveTemplates(message, vars = {}) {
  return message.replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null) {
      return String(vars[key]);
    }
    return match;
  });
}
