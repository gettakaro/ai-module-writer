import { Client, EventOutputDTO, EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';

export interface WaitForEventOptions {
  eventName: EventSearchInputAllowedFiltersEventNameEnum;
  gameserverId: string;
  /** Only return events created after this timestamp */
  after: Date;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Poll interval in milliseconds (default: 1000) */
  pollInterval?: number;
}

export async function waitForEvent(client: Client, options: WaitForEventOptions): Promise<EventOutputDTO> {
  const {
    eventName,
    gameserverId,
    after,
    timeout = 30000,
    pollInterval = 1000,
  } = options;

  const deadline = Date.now() + timeout;
  const searchAfter = new Date(after.getTime() - 1500);

  while (Date.now() < deadline) {
    const result = await client.event.eventControllerSearch({
      filters: {
        eventName: [eventName],
        gameserverId: [gameserverId],
      },
      greaterThan: {
        createdAt: searchAfter.toISOString(),
      },
    });

    const events = [...result.data.data].sort((left, right) => (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    ));
    const exactMatch = events.find((event) => new Date(event.createdAt).getTime() >= after.getTime());
    if (exactMatch) {
      return exactMatch;
    }

    if (events.length > 0) {
      const newest = events[events.length - 1]!;
      const newestAgeMs = Math.abs(new Date(newest.createdAt).getTime() - after.getTime());
      if (newestAgeMs <= 1500) {
        return newest;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timed out waiting for event '${eventName}' on gameserver '${gameserverId}' after ${timeout}ms`,
  );
}
