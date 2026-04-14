import { takaro } from '@takaro/helpers';

export const STATS_KEY = 'kt_stats';
export const SEASON_KEY = 'kt_season';

export const DEFAULT_STATS = {
  kills: 0,
  pvpKills: 0,
  mobKills: 0,
  deaths: 0,
  points: 0,
  currentStreak: 0,
  bestStreak: 0,
};

async function findVariable(gameServerId, moduleId, key, playerId) {
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

async function writeVariable(gameServerId, moduleId, key, playerId, value) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    const createData = {
      key,
      value: serialized,
      gameServerId,
      moduleId,
    };
    if (playerId) {
      createData.playerId = playerId;
    }
    await takaro.variable.variableControllerCreate(createData);
  }
}

/**
 * Get stats for a specific player. Returns DEFAULT_STATS if not found.
 * Merges parsed value with DEFAULT_STATS so partial/old records never cause NaN.
 *
 * Note: read-modify-write — concurrent events for the same player may lose an update
 * (no atomic ops in the variable API). Accepted limitation; rare in practice.
 */
export async function getPlayerStats(gameServerId, moduleId, playerId) {
  const variable = await findVariable(gameServerId, moduleId, STATS_KEY, playerId);
  if (!variable) return { ...DEFAULT_STATS };
  try {
    return { ...DEFAULT_STATS, ...JSON.parse(variable.value) };
  } catch (err) {
    console.error(`tracker-helpers: getPlayerStats failed to parse stats for player ${playerId}. Returning defaults. Error: ${err}`);
    return { ...DEFAULT_STATS };
  }
}

export async function setPlayerStats(gameServerId, moduleId, playerId, stats) {
  await writeVariable(gameServerId, moduleId, STATS_KEY, playerId, stats);
}

export async function getAllPlayerStats(gameServerId, moduleId) {
  const results = [];
  const limit = 100;
  let page = 0;

  while (true) {
    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [STATS_KEY],
        gameServerId: [gameServerId],
        moduleId: [moduleId],
      },
      limit,
      page,
    });

    const records = res.data.data;
    for (const record of records) {
      if (!record.playerId) continue;
      try {
        const stats = { ...DEFAULT_STATS, ...JSON.parse(record.value) };
        results.push({ playerId: record.playerId, stats });
      } catch (err) {
        console.error(`tracker-helpers: getAllPlayerStats failed to parse stats for player ${record.playerId}. Skipping. Error: ${err}`);
      }
    }

    if (records.length < limit) break;
    page++;
  }

  return results;
}

export async function deleteAllPlayerStats(gameServerId, moduleId) {
  const limit = 100;
  let iterations = 0;

  while (true) {
    if (iterations > 100) {
      console.error('deleteAllPlayerStats: safety limit reached, some records may remain');
      break;
    }

    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [STATS_KEY],
        gameServerId: [gameServerId],
        moduleId: [moduleId],
      },
      limit,
      page: 0,
    });

    const records = res.data.data;
    if (records.length === 0) break;

    // Delete all records in parallel; use allSettled so one failure doesn't abort the rest
    const results = await Promise.allSettled(records.map((record) => takaro.variable.variableControllerDelete(record.id)));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`tracker-helpers: deleteAllPlayerStats failed to delete a variable: ${result.reason}`);
      }
    }

    if (records.length < limit) break;
    iterations++;
  }
}

// Returns true if a record was found and deleted, false if none existed.
export async function deletePlayerStats(gameServerId, moduleId, playerId) {
  const variable = await findVariable(gameServerId, moduleId, STATS_KEY, playerId);
  if (variable) {
    await takaro.variable.variableControllerDelete(variable.id);
    return true;
  }
  return false;
}

export async function getSeasonInfo(gameServerId, moduleId) {
  const defaultSeason = { number: 1, startedAt: new Date().toISOString() };
  const variable = await findVariable(gameServerId, moduleId, SEASON_KEY, null);
  if (!variable) {
    return { ...defaultSeason };
  }
  try {
    const season = JSON.parse(variable.value);
    if (typeof season.number !== 'number' || isNaN(season.number)) {
      console.error(`tracker-helpers: getSeasonInfo found invalid season number (${season.number}). Returning defaults.`);
      return { ...defaultSeason };
    }
    return season;
  } catch (err) {
    console.error(`tracker-helpers: getSeasonInfo failed to parse season data. Returning defaults. Error: ${err}`);
    return { ...defaultSeason };
  }
}

export async function setSeasonInfo(gameServerId, moduleId, data) {
  await writeVariable(gameServerId, moduleId, SEASON_KEY, null, data);
}

export function formatKD(kills, deaths) {
  if (kills === 0 && deaths === 0) return 'N/A';
  if (deaths === 0) return `${kills} (no deaths)`;
  return (kills / deaths).toFixed(2);
}

export function sortByRank(allStats) {
  return [...allStats].sort((a, b) => {
    if (b.stats.points !== a.stats.points) return b.stats.points - a.stats.points;
    return b.stats.kills - a.stats.kills;
  });
}

export function recordKill(stats, killType, config, basePoints, multiplier) {
  stats.kills += 1;
  if (killType === 'pvp') {
    stats.pvpKills += 1;
  } else {
    stats.mobKills += 1;
  }
  stats.currentStreak += 1;
  if (stats.currentStreak > stats.bestStreak) {
    stats.bestStreak = stats.currentStreak;
  }

  const pointsEarned = basePoints * multiplier;
  stats.points += pointsEarned;

  let bonusAwarded = 0;
  const streakInterval = config.streakBonusInterval;
  if (streakInterval > 0 && stats.currentStreak % streakInterval === 0) {
    bonusAwarded = config.streakBonusPoints;
    stats.points += bonusAwarded;
  }

  return { pointsEarned, bonusAwarded };
}
