// Pure functions extracted from daily-helpers.js.
// No Takaro imports — safe to import in unit tests without mocking.

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
    console.error(`daily-pure: getClaimStatus got invalid date '${dailyData.lastClaimAt}', treating as never-claimed`);
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
