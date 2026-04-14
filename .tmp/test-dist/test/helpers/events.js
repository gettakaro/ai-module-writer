export async function waitForEvent(client, options) {
    const { eventName, gameserverId, after, timeout = 30000, pollInterval = 1000, } = options;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await client.event.eventControllerSearch({
            filters: {
                eventName: [eventName],
                gameserverId: [gameserverId],
            },
            greaterThan: {
                createdAt: after.toISOString(),
            },
        });
        const events = result.data.data;
        if (events.length > 0) {
            return events[0];
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    throw new Error(`Timed out waiting for event '${eventName}' on gameserver '${gameserverId}' after ${timeout}ms`);
}
