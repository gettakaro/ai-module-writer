import { randomUUID } from 'crypto';
import { getMockServer } from '@takaro/mock-gameserver';
import { Client, GameServerOutputDTO, PlayerOnGameserverOutputDTO } from '@takaro/apiclient';
import { Redis } from '@takaro/db';
import { config } from 'dotenv';

config();

type MockGameServer = Awaited<ReturnType<typeof getMockServer>>;

export interface MockServerContext {
  server: MockGameServer;
  gameServer: GameServerOutputDTO;
  players: PlayerOnGameserverOutputDTO[];
  identityToken: string;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry<T>(fn: () => Promise<T>, maxAttempts: number, delayMs: number, label?: string): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxAttempts - 1) throw err;
      const context = label ? ` [${label}]` : '';
      console.error(`Retry ${i + 1}/${maxAttempts}${context}: ${(err as Error).message}, retrying in ${delayMs}ms...`);
      await wait(delayMs);
    }
  }
  throw new Error('Retry exhausted');
}

export async function startMockServer(client: Client): Promise<MockServerContext> {
  const registrationToken = process.env['TAKARO_REGISTRATION_TOKEN'];
  const wsUrl = process.env['TAKARO_WS_URL'];

  if (!registrationToken) throw new Error('TAKARO_REGISTRATION_TOKEN is required');
  if (!wsUrl) throw new Error('TAKARO_WS_URL is required');

  const identityToken = `test-${randomUUID()}`;

  const population = {
    totalPlayers: 3,
  };

  const server = await getMockServer({
    mockserver: {
      registrationToken,
      identityToken,
      name: `test-server-${identityToken}`,
    },
    ws: {
      url: wsUrl,
    },
    simulation: {
      autoStart: false,
    },
    population,
  });

  try {
    // Discover the game server in Takaro by identityToken
    const gameServer: GameServerOutputDTO = await retry(
      async () => {
        const result = await client.gameserver.gameServerControllerSearch({
          filters: { identityToken: [identityToken] },
        });
        const found = result.data.data[0];
        if (!found) throw new Error(`Game server with identityToken ${identityToken} not found yet`);
        return found;
      },
      30,
      2000,
      'discover game server',
    );

    // Connect all players (sends player-connected events to Takaro)
    await server.executeConsoleCommand('connectAll');

    // Wait for players to appear in Takaro's playerOnGameserver records
    const players: PlayerOnGameserverOutputDTO[] = await retry(
      async () => {
        const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
          filters: {
            gameServerId: [gameServer.id],
            online: [true],
          },
        });
        const found = result.data.data;
        if (found.length < population.totalPlayers) throw new Error(`Waiting for ${population.totalPlayers} players to be online, only ${found.length} found so far`);
        return found;
      },
      20,
      2000,
      'wait for players',
    );

    return { server, gameServer, players, identityToken };
  } catch (err) {
    // Clean up server resources before re-throwing so the process can exit cleanly
    await stopMockServer(server).catch((cleanupErr) => {
      console.error('startMockServer: cleanup after failure threw:', cleanupErr);
    });
    throw err;
  }
}

type WsClient = {
  ws: { terminate: () => void; close: () => void; on: (event: string, fn: () => void) => void } | null;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  pingTimeout: ReturnType<typeof setTimeout> | null;
  scheduleReconnect: () => void;
  connect: () => void;
};

function forceStopWsClient(wsClient: WsClient): void {
  // Disable reconnect and ping loop so timers don't keep the event loop alive.
  wsClient.scheduleReconnect = () => {};
  wsClient.connect = () => {};
  if (wsClient.pingTimeout) {
    clearTimeout(wsClient.pingTimeout);
    wsClient.pingTimeout = null;
  }
  if (wsClient.reconnectTimeout) {
    clearTimeout(wsClient.reconnectTimeout);
    wsClient.reconnectTimeout = null;
  }
  if (wsClient.ws) {
    try { wsClient.ws.terminate(); } catch (terminateErr) { console.error('forceStopWsClient: ws.terminate() failed (safe to ignore):', terminateErr); }
    wsClient.ws = null;
  }
}

export async function stopMockServer(
  server: MockGameServer,
  client?: Client,
  gameServerId?: string,
): Promise<void> {
  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | void> =>
    Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, ms))]);

  // Disable the wsClient's reconnect loop BEFORE calling shutdown/disconnect.
  // This prevents the ws.close() close-event from triggering new reconnect timers
  // that would keep the Node.js event loop alive after tests complete.
  try {
    // Fragile: accesses wsClient via `as unknown as` cast because the mock server
    // type does not expose it publicly. If the mock-server library changes its
    // internal structure this cast will silently break. Acceptable trade-off since
    // the worst outcome is lingering timers that delay test exit (not a correctness bug).
    const wsClient = (server as unknown as { wsClient: WsClient }).wsClient;
    if (wsClient) forceStopWsClient(wsClient);
  } catch (err) {
    console.error('stopMockServer: failed to disable wsClient reconnect:', err);
  }

  await withTimeout(server.shutdown(), 2000);

  // Delete the game server record from Takaro to prevent orphan accumulation
  if (client && gameServerId) {
    try {
      await client.gameserver.gameServerControllerRemove(gameServerId);
    } catch (err) {
      console.error(`stopMockServer: failed to delete game server '${gameServerId}':`, err);
    }
  }
  // Disconnect Redis clients opened by the mock server's GameDataHandler.
  // Without this, open Redis connections keep the Node.js event loop alive
  // and the test process never exits.
  // Guard with try/catch: when multiple describe blocks each call stopMockServer,
  // the second+ calls may attempt to disconnect already-closed clients.
  try {
    await withTimeout(Redis.destroy(), 3000);
  } catch (redisErr) {
    console.error('stopMockServer: Redis.destroy() failed (safe to ignore if client already closed):', redisErr);
  }
}
