import { takaro } from '@takaro/helpers';

const AFK_TRACKING_KEY = 'afk_tracking';

/**
 * Read AFK tracking state from Takaro variables.
 * Returns parsed JSON object or {} if not set.
 */
export async function getAfkTracking(gameServerId, moduleId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [AFK_TRACKING_KEY],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });
  if (res.data.data.length === 0) return {};
  try {
    return JSON.parse(res.data.data[0].value);
  } catch (err) {
    console.error(`afk-helpers: getAfkTracking failed to parse stored value, resetting to {}. Error: ${err}`);
    return {};
  }
}

/**
 * Write AFK tracking state to Takaro variables.
 * Creates the variable if not existing, updates if existing.
 */
export async function setAfkTracking(gameServerId, moduleId, data) {
  const existing = await takaro.variable.variableControllerSearch({
    filters: {
      key: [AFK_TRACKING_KEY],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });
  const serialized = JSON.stringify(data);
  if (existing.data.data.length > 0) {
    await takaro.variable.variableControllerUpdate(existing.data.data[0].id, { value: serialized });
  } else {
    await takaro.variable.variableControllerCreate({
      key: AFK_TRACKING_KEY,
      value: serialized,
      gameServerId,
      moduleId,
    });
  }
}
