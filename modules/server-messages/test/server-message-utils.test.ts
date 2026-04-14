import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutionLockHeartbeat,
  findUnknownPlaceholders,
  getIntervalStatus,
  normalizeMessages,
  renderPlaceholders,
} from '../src/functions/server-message-utils.js';

describe('server-message utils', () => {
  it('normalizes messages by dropping non-text entries and bounding weights', () => {
    const normalized = normalizeMessages([
      null,
      { text: 'Alpha', weight: 0 },
      { text: 'Beta', weight: 99 },
      { text: 'Gamma', weight: 2 },
      { nope: true },
    ]);

    assert.deepEqual(normalized, [
      { text: 'Alpha', weight: 1 },
      { text: 'Beta', weight: 20 },
      { text: 'Gamma', weight: 2 },
    ]);
  });

  it('finds unsupported placeholders and leaves them unchanged when rendering', () => {
    assert.deepEqual(findUnknownPlaceholders('Hello {serverName} {unknown} {playerCount} {unknown}'), ['unknown']);
    assert.equal(
      renderPlaceholders('Hello {serverName} {unknown} ({playerCount})', { serverName: 'Paper One', playerCount: 3 }),
      'Hello Paper One {unknown} (3)',
    );
  });

  it('evaluates cron expressions with lists, ranges, steps, and day-of-week aliases', () => {
    const mondayMatch = getIntervalStatus('0,15,30,45 9-17/2 * * 1-5', new Date('2026-04-13T13:15:00.000Z'), 'UTC');
    assert.equal(mondayMatch.valid, true);
    assert.equal(mondayMatch.matches, true);

    const mondayMiss = getIntervalStatus('0,15,30,45 9-17/2 * * 1-5', new Date('2026-04-13T14:15:00.000Z'), 'UTC');
    assert.equal(mondayMiss.valid, true);
    assert.equal(mondayMiss.matches, false);

    const sundaySeven = getIntervalStatus('0 9 * * 7', new Date('2026-04-12T09:00:00.000Z'), 'UTC');
    assert.equal(sundaySeven.valid, true);
    assert.equal(sundaySeven.matches, true);

    const invalidDescendingRange = getIntervalStatus('5-1 * * * *', new Date('2026-04-13T09:00:00.000Z'), 'UTC');
    assert.equal(invalidDescendingRange.valid, false);
  });

  it('schedules heartbeats, deduplicates concurrent refreshes, and stops rescheduling after failure', async () => {
    const scheduled: Array<{ id: symbol; fn: () => void }> = [];
    const cancelled = new Set<symbol>();
    let refreshCalls = 0;
    let allowRefresh = true;
    let releaseRefresh: (() => void) | undefined;

    const heartbeat = createExecutionLockHeartbeat(
      async () => {
        refreshCalls += 1;
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        return allowRefresh;
      },
      {
        intervalMs: 10,
        setTimeoutFn: (fn: () => void) => {
          const id = Symbol('timeout');
          scheduled.push({ id, fn });
          return id;
        },
        clearTimeoutFn: (id: symbol) => {
          cancelled.add(id);
        },
      },
    );

    assert.equal(scheduled.length, 1);

    const firstTimer = scheduled.shift()!;
    firstTimer.fn();

    const firstPromise = heartbeat.heartbeat();
    const secondPromise = heartbeat.heartbeat();
    assert.equal(refreshCalls, 1, 'concurrent heartbeats should share the same refresh call');

    releaseRefresh?.();
    assert.equal(await firstPromise, true);
    assert.equal(await secondPromise, true);
    assert.equal(scheduled.length, 1, 'successful refresh should schedule the next heartbeat');

    allowRefresh = false;
    const secondTimer = scheduled.shift()!;
    secondTimer.fn();
    const failedRefresh = heartbeat.heartbeat();
    releaseRefresh?.();
    assert.equal(await failedRefresh, false);
    assert.equal(scheduled.length, 0, 'failed refresh should not schedule another heartbeat');

    await heartbeat.stopHeartbeat();
    assert.ok(cancelled.has(firstTimer.id) || cancelled.has(secondTimer.id));
  });
});
