import { takaro } from '@takaro/helpers';

// Pure constants and functions are also defined in daily-pure.js (no Takaro imports)
// for direct use in unit tests. Keep both files in sync when changing pure logic.
export const DAILY_KEY = 'dr_daily';

export const STREAK_AT_RISK_THRESHOLD = 0.25;

export const DEFAULT_DAILY = {
  lastClaimAt: null,
  currentStreak: 0,
  bestStreak: 0,
  totalClaimed: 0,
};

export function getClaimStatus(dailyData, gracePeriodHours) {
  const now = Date.now();
  const cooldownMs = 24 * 60 * 60 * 1000;
  const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;

  if (dailyData.lastClaimAt === null) {
    return {
      canClaim: true,
      streakAlive: true,
      msUntilCanClaim: 0,
      msUntilStreakExpires: null,
    };
  }

  const lastClaimMs = new Date(dailyData.lastClaimAt).getTime();

  if (isNaN(lastClaimMs)) {
    console.error(`daily-helpers: getClaimStatus got invalid date '${dailyData.lastClaimAt}', treating as never-claimed`);
    return {
      canClaim: true,
      streakAlive: true,
      msUntilCanClaim: 0,
      msUntilStreakExpires: null,
    };
  }

  const msElapsed = now - lastClaimMs;
  const msUntilCanClaim = Math.max(0, cooldownMs - msElapsed);
  const canClaim = msUntilCanClaim === 0;

  const streakAlive = msElapsed < gracePeriodMs;
  const msUntilStreakExpires = streakAlive ? (gracePeriodMs - msElapsed) : 0;

  return {
    canClaim,
    streakAlive,
    msUntilCanClaim,
    msUntilStreakExpires,
  };
}

export function calculateReward(baseReward, streak, multiplier, milestones, maxStreak) {
  // Guard: streak must be at least 1 to produce a non-zero reward.
  // Callers should ensure streak >= 1 before calling (e.g. after incrementing newStreak).
  const effectiveStreak = Math.max(1, streak);
  const cappedStreak = Math.min(effectiveStreak, maxStreak);
  const base = baseReward ?? 100;
  const baseTotal = base * cappedStreak * multiplier;

  const milestone = milestones ? milestones.find((m) => m.days === cappedStreak) : null;
  const milestoneBonus = milestone ? milestone.reward : 0;
  const milestoneMessage = milestone ? milestone.message : null;

  return {
    totalReward: baseTotal + milestoneBonus,
    milestoneBonus,
    milestoneMessage,
  };
}

export function formatTimeRemaining(ms) {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * Returns whether a streak is at risk of expiring, plus the time remaining.
 * Used in /streak and dailyLoginCheck to compute at-risk warnings.
 */
export function isStreakAtRisk(status, gracePeriodHours) {
  if (!status.streakAlive) return { atRisk: false, timeRemaining: null };
  if (status.msUntilStreakExpires == null) return { atRisk: false, timeRemaining: null };

  const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;
  const percentRemaining = status.msUntilStreakExpires / gracePeriodMs;
  if (percentRemaining < STREAK_AT_RISK_THRESHOLD) {
    return { atRisk: true, timeRemaining: formatTimeRemaining(status.msUntilStreakExpires) };
  }
  return { atRisk: false, timeRemaining: null };
}

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
  // NOTE: No atomic read-modify-write in Takaro variables. Rapid concurrent /daily
  // calls can race here — the last writer wins and totalClaimed may be undercounted.
  // This is the same limitation as kill-tracker and is an acceptable trade-off for simplicity.
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

export async function getPlayerDaily(gameServerId, moduleId, playerId) {
  const variable = await findVariable(gameServerId, moduleId, DAILY_KEY, playerId);
  if (!variable) return { ...DEFAULT_DAILY };
  try {
    return { ...DEFAULT_DAILY, ...JSON.parse(variable.value) };
  } catch (err) {
    console.error(`daily-helpers: getPlayerDaily failed to parse data for player ${playerId}. Returning defaults. Error: ${err}`);
    return { ...DEFAULT_DAILY };
  }
}

export async function setPlayerDaily(gameServerId, moduleId, playerId, data) {
  await writeVariable(gameServerId, moduleId, DAILY_KEY, playerId, data);
}

export async function getAllPlayerDaily(gameServerId, moduleId) {
  const results = [];
  const limit = 100;
  let page = 0;
  let iterations = 0;

  while (true) {
    iterations++;
    if (iterations > 100) {
      console.error('daily-helpers: getAllPlayerDaily exceeded 100 iterations, aborting pagination');
      break;
    }

    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [DAILY_KEY],
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
        const daily = { ...DEFAULT_DAILY, ...JSON.parse(record.value) };
        results.push({ playerId: record.playerId, daily });
      } catch (err) {
        console.error(`daily-helpers: getAllPlayerDaily failed to parse data for player ${record.playerId}. Skipping. Error: ${err}`);
      }
    }

    if (records.length < limit) break;
    page++;
  }

  return results;
}
