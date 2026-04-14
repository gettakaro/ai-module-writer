import { takaro } from '@takaro/helpers';

export const LOTTERY_POT_KEY = 'lottery_pot';
export const LOTTERY_DRAW_NUMBER_KEY = 'lottery_draw_number';
export const LOTTERY_ROLLOVER_KEY = 'lottery_rollover';
export const LOTTERY_TICKETS_KEY = 'lottery_tickets';

/**
 * Generic variable read helper. Returns the variable record or null if not found.
 */
export async function findVariable(gameServerId, moduleId, key, playerId) {
  const filters = {
    key: [key],
    gameServerId: [gameServerId],
    moduleId: [moduleId],
  };
  if (playerId) {
    filters.playerId = [playerId];
  }
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

/**
 * Generic variable write helper. Creates if not existing, updates if existing.
 */
export async function writeVariable(gameServerId, moduleId, key, value, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    const payload = { key, value: serialized, gameServerId, moduleId };
    if (playerId) payload.playerId = playerId;
    await takaro.variable.variableControllerCreate(payload);
  }
}

/**
 * Generic variable delete helper.
 */
export async function deleteVariable(gameServerId, moduleId, key, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  if (existing) {
    await takaro.variable.variableControllerDelete(existing.id);
  }
}

// ---- Global state helpers ----

export async function getPot(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, LOTTERY_POT_KEY);
  if (!variable) return 0;
  try {
    const val = Math.floor(JSON.parse(variable.value));
    return isNaN(val) ? 0 : val;
  } catch (err) {
    console.error(`lottery-helpers: getPot failed to parse stored value, returning 0. Error: ${err}`);
    return 0;
  }
}

export async function setPot(gameServerId, moduleId, amount) {
  if (typeof amount !== 'number' || isNaN(amount)) amount = 0;
  await writeVariable(gameServerId, moduleId, LOTTERY_POT_KEY, Math.floor(amount));
}

export async function getRollover(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, LOTTERY_ROLLOVER_KEY);
  if (!variable) return 0;
  try {
    const val = Math.floor(JSON.parse(variable.value));
    return isNaN(val) ? 0 : val;
  } catch (err) {
    console.error(`lottery-helpers: getRollover failed to parse stored value, returning 0. Error: ${err}`);
    return 0;
  }
}

export async function setRollover(gameServerId, moduleId, amount) {
  if (typeof amount !== 'number' || isNaN(amount)) amount = 0;
  await writeVariable(gameServerId, moduleId, LOTTERY_ROLLOVER_KEY, Math.floor(amount));
}

export async function getDrawNumber(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, LOTTERY_DRAW_NUMBER_KEY);
  if (!variable) return 0;
  try {
    const val = Math.floor(JSON.parse(variable.value));
    return isNaN(val) ? 0 : val;
  } catch (err) {
    console.error(`lottery-helpers: getDrawNumber failed to parse stored value, returning 0. Error: ${err}`);
    return 0;
  }
}

export async function setDrawNumber(gameServerId, moduleId, num) {
  if (typeof num !== 'number' || isNaN(num)) num = 0;
  await writeVariable(gameServerId, moduleId, LOTTERY_DRAW_NUMBER_KEY, Math.floor(num));
}

// ---- Per-player helpers ----

export async function getPlayerTickets(gameServerId, moduleId, playerId) {
  const variable = await findVariable(gameServerId, moduleId, LOTTERY_TICKETS_KEY, playerId);
  if (!variable) return 0;
  try {
    const val = Math.floor(JSON.parse(variable.value));
    return isNaN(val) ? 0 : val;
  } catch (err) {
    console.error(`lottery-helpers: getPlayerTickets failed to parse stored value, returning 0. Error: ${err}`);
    return 0;
  }
}

export async function setPlayerTickets(gameServerId, moduleId, playerId, tickets) {
  if (typeof tickets !== 'number' || isNaN(tickets)) tickets = 0;
  await writeVariable(gameServerId, moduleId, LOTTERY_TICKETS_KEY, Math.floor(tickets), playerId);
}

/**
 * Paginated search for all lottery_tickets variables.
 * Returns [{playerId, tickets, variableId}]
 */
export async function getAllTicketEntries(gameServerId, moduleId) {
  const entries = [];
  let page = 0;
  const limit = 100;
  while (true) {
    if (page > 100) break;
    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [LOTTERY_TICKETS_KEY],
        gameServerId: [gameServerId],
        moduleId: [moduleId],
      },
      page,
      limit,
    });
    const batch = res.data.data;
    for (const v of batch) {
      try {
        const tickets = Math.floor(JSON.parse(v.value));
        if (!isNaN(tickets) && tickets > 0 && v.playerId) {
          entries.push({ playerId: v.playerId, tickets, variableId: v.id });
        }
      } catch (err) {
        console.error(`lottery-helpers: failed to parse ticket variable ${v.id}, skipping. Error: ${err}`);
      }
    }
    if (entries.length >= res.data.meta.total || batch.length < limit) break;
    page++;
  }
  return entries;
}

/**
 * Paginated delete of all lottery_tickets variables.
 */
export async function deleteAllTickets(gameServerId, moduleId) {
  let deleted = 0;
  let iterations = 0;
  while (true) {
    if (iterations > 100) break;
    iterations++;
    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [LOTTERY_TICKETS_KEY],
        gameServerId: [gameServerId],
        moduleId: [moduleId],
      },
      page: 0,
      limit: 100,
    });
    const batch = res.data.data;
    if (batch.length === 0) break;
    const results = await Promise.allSettled(batch.map(v => takaro.variable.variableControllerDelete(v.id)));
    deleted += results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.filter(r => r.status === 'rejected');
    if (rejected.length > 0) {
      rejected.forEach(r => console.error(`lottery-helpers: deleteAllTickets failed to delete a ticket record. Reason: ${r.reason}`));
    }
    if (batch.length < 100) break;
  }
  console.log(`lottery-helpers: deleteAllTickets deleted ${deleted} ticket records`);
}
