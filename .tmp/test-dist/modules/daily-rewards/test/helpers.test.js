// Hook coverage note: the `daily-login-check` hook (player-connected event) is intentionally
// not covered by automated tests. It requires a real player-connected event to be fired.
// Hook behavior is verified via in-game testing with the bot service (see SKILL.md Phase 5).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';
// Import the REAL pure functions directly — no Takaro runtime needed.
// If the source implementation changes, these tests will catch the regression.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const purePath = path.resolve(__dirname, '../src/functions/daily-pure.js');
const { getClaimStatus, calculateReward, formatTimeRemaining, isStreakAtRisk } = await import(purePath);
describe('daily-rewards: helper unit tests', () => {
    describe('getClaimStatus', () => {
        it('should allow claim when never claimed (lastClaimAt=null)', () => {
            const data = { lastClaimAt: null, currentStreak: 0, bestStreak: 0, totalClaimed: 0 };
            const status = getClaimStatus(data, 48);
            assert.equal(status.canClaim, true);
            assert.equal(status.streakAlive, true);
            assert.equal(status.msUntilCanClaim, 0);
            assert.equal(status.msUntilStreakExpires, null);
        });
        it('should block claim when claimed less than 24h ago', () => {
            const claimedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
            const data = { lastClaimAt: claimedAt, currentStreak: 1, bestStreak: 1, totalClaimed: 100 };
            const status = getClaimStatus(data, 48);
            assert.equal(status.canClaim, false);
            assert.ok(status.msUntilCanClaim > 0, 'msUntilCanClaim should be positive');
            assert.equal(status.streakAlive, true);
        });
        it('should allow claim when last claimed more than 24h ago', () => {
            const claimedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
            const data = { lastClaimAt: claimedAt, currentStreak: 1, bestStreak: 1, totalClaimed: 100 };
            const status = getClaimStatus(data, 48);
            assert.equal(status.canClaim, true);
            assert.equal(status.streakAlive, true);
        });
        it('should mark streak dead when grace period expired', () => {
            const claimedAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(); // 49h ago, grace=48h
            const data = { lastClaimAt: claimedAt, currentStreak: 5, bestStreak: 10, totalClaimed: 500 };
            const status = getClaimStatus(data, 48);
            assert.equal(status.canClaim, true);
            assert.equal(status.streakAlive, false);
        });
        it('should treat invalid date as never-claimed (NaN protection)', () => {
            const data = { lastClaimAt: 'not-a-date', currentStreak: 5, bestStreak: 10, totalClaimed: 500 };
            const status = getClaimStatus(data, 48);
            assert.equal(status.canClaim, true);
            assert.equal(status.streakAlive, true);
            assert.equal(status.msUntilCanClaim, 0);
        });
        it('should return msUntilStreakExpires=0 when streak is dead', () => {
            const claimedAt = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // way expired
            const data = { lastClaimAt: claimedAt, currentStreak: 5, bestStreak: 10, totalClaimed: 500 };
            const status = getClaimStatus(data, 48);
            assert.equal(status.streakAlive, false);
            assert.equal(status.msUntilStreakExpires, 0);
        });
    });
    describe('calculateReward', () => {
        it('should return baseReward * streak * multiplier with no milestone', () => {
            const result = calculateReward(100, 5, 1, [], 365);
            assert.equal(result.totalReward, 500);
            assert.equal(result.milestoneBonus, 0);
            assert.equal(result.milestoneMessage, null);
        });
        it('should apply multiplier correctly', () => {
            const result = calculateReward(100, 5, 3, [], 365);
            assert.equal(result.totalReward, 1500);
        });
        it('should cap streak at maxStreak', () => {
            const result = calculateReward(100, 400, 1, [], 365);
            assert.equal(result.totalReward, 36500); // 100 * 365 * 1
        });
        it('should apply milestone bonus when capped streak matches milestone days', () => {
            const milestones = [{ days: 7, reward: 1000, message: 'Week bonus!' }];
            const result = calculateReward(100, 7, 1, milestones, 365);
            assert.equal(result.milestoneBonus, 1000);
            assert.equal(result.milestoneMessage, 'Week bonus!');
            assert.equal(result.totalReward, 1700); // 100*7*1 + 1000
        });
        it('should use capped streak for milestone matching (not raw streak)', () => {
            // streak=400, maxStreak=365, cappedStreak=365 → milestone at 365 should fire
            const milestones = [{ days: 365, reward: 100000, message: 'Legend!' }];
            const result = calculateReward(100, 400, 1, milestones, 365);
            assert.equal(result.milestoneBonus, 100000);
            assert.equal(result.totalReward, 100000 + 36500);
        });
        it('should NOT fire milestone when raw streak matches but capped streak does not', () => {
            // streak=7, maxStreak=5, cappedStreak=5 → milestone at 7 should NOT fire
            const milestones = [{ days: 7, reward: 1000, message: 'Week bonus!' }];
            const result = calculateReward(100, 7, 1, milestones, 5);
            assert.equal(result.milestoneBonus, 0);
            assert.equal(result.totalReward, 500); // 100 * 5 * 1
        });
        it('should use ?? 100 fallback only when baseReward is null or undefined', () => {
            // With nullish coalescing, 0 is NOT replaced (only null/undefined are)
            const resultZero = calculateReward(0, 5, 1, [], 365);
            assert.equal(resultZero.totalReward, 0); // 0 * 5 * 1 = 0
            const resultNull = calculateReward(null, 5, 1, [], 365);
            assert.equal(resultNull.totalReward, 500); // 100 * 5 * 1
            const resultUndefined = calculateReward(undefined, 5, 1, [], 365);
            assert.equal(resultUndefined.totalReward, 500); // 100 * 5 * 1
        });
        it('should handle null milestones gracefully', () => {
            const result = calculateReward(100, 7, 2, null, 365);
            assert.equal(result.totalReward, 1400);
            assert.equal(result.milestoneBonus, 0);
        });
        it('should return at least baseReward when streak=0 (Math.max guard)', () => {
            // streak=0 is guarded to Math.max(1, 0)=1, so result = base * 1 * multiplier
            const result = calculateReward(100, 0, 1, [], 365);
            assert.equal(result.totalReward, 100);
        });
    });
    describe('formatTimeRemaining', () => {
        it('should return "0m" for zero or negative ms', () => {
            assert.equal(formatTimeRemaining(0), '0m');
            assert.equal(formatTimeRemaining(-1000), '0m');
        });
        it('should format minutes only', () => {
            assert.equal(formatTimeRemaining(30 * 60 * 1000), '30m');
        });
        it('should format hours only', () => {
            assert.equal(formatTimeRemaining(3 * 60 * 60 * 1000), '3h');
        });
        it('should format hours and minutes', () => {
            assert.equal(formatTimeRemaining(5 * 60 * 60 * 1000 + 23 * 60 * 1000), '5h 23m');
        });
        it('should round up partial minutes', () => {
            assert.equal(formatTimeRemaining(90 * 1000), '2m'); // 1.5 min → 2m
        });
    });
    describe('isStreakAtRisk', () => {
        it('should return atRisk=true when streak is alive and <25% of grace period remains', () => {
            const gracePeriodHours = 48;
            const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;
            // 10% remaining = well below the 25% threshold
            const msUntilStreakExpires = gracePeriodMs * 0.10;
            const status = { streakAlive: true, msUntilCanClaim: 0, msUntilStreakExpires };
            const result = isStreakAtRisk(status, gracePeriodHours);
            assert.equal(result.atRisk, true);
            assert.ok(result.timeRemaining !== null, 'timeRemaining should be set when at risk');
        });
        it('should return atRisk=false when streak is alive and >25% of grace period remains', () => {
            const gracePeriodHours = 48;
            const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;
            // 50% remaining = safely above the 25% threshold
            const msUntilStreakExpires = gracePeriodMs * 0.50;
            const status = { streakAlive: true, msUntilCanClaim: 0, msUntilStreakExpires };
            const result = isStreakAtRisk(status, gracePeriodHours);
            assert.equal(result.atRisk, false);
            assert.equal(result.timeRemaining, null);
        });
        it('should return atRisk=false when streak is not alive (already expired)', () => {
            const status = { streakAlive: false, msUntilCanClaim: 0, msUntilStreakExpires: 0 };
            const result = isStreakAtRisk(status, 48);
            assert.equal(result.atRisk, false);
            assert.equal(result.timeRemaining, null);
        });
        it('should return atRisk=false when msUntilStreakExpires=null (never claimed player)', () => {
            // Never claimed: getClaimStatus returns msUntilStreakExpires=null.
            // isStreakAtRisk guards against null and returns atRisk=false to avoid
            // false "streak at risk" warnings for players who have never claimed.
            const status = { streakAlive: true, msUntilCanClaim: 0, msUntilStreakExpires: null };
            const result = isStreakAtRisk(status, 48);
            assert.equal(result.atRisk, false);
            assert.equal(result.timeRemaining, null);
        });
        it('should return atRisk=false when exactly 25% of grace period remains (boundary: condition is strict <)', () => {
            const gracePeriodHours = 48;
            const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;
            // Exactly 25% remaining — condition is `< 0.25`, so exactly 0.25 means NOT at risk
            const msUntilStreakExpires = gracePeriodMs * 0.25;
            const status = { streakAlive: true, msUntilCanClaim: 0, msUntilStreakExpires };
            const result = isStreakAtRisk(status, gracePeriodHours);
            assert.equal(result.atRisk, false);
            assert.equal(result.timeRemaining, null);
        });
    });
});
