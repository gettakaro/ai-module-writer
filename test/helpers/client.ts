import { config } from 'dotenv';
import { Client } from '@takaro/apiclient';

config();

// Singleton client for the test run. Tests run sequentially (--test-concurrency 1)
// so a single shared authenticated client is safe. Note: there is no cache invalidation —
// if the token expires mid-run or tests are run with different credentials across invocations,
// create a fresh process (the singleton lives only for the duration of the Node.js process).
let cachedClient: Client | null = null;

export async function createClient(): Promise<Client> {
  if (cachedClient) return cachedClient;

  const url = process.env['TAKARO_HOST'];
  const username = process.env['TAKARO_USERNAME'];
  const password = process.env['TAKARO_PASSWORD'];
  const domainId = process.env['TAKARO_DOMAIN_ID'];

  if (!url) throw new Error('TAKARO_HOST is required');
  if (!username) throw new Error('TAKARO_USERNAME is required');
  if (!password) throw new Error('TAKARO_PASSWORD is required');
  if (!domainId) throw new Error('TAKARO_DOMAIN_ID is required');

  const client = new Client({
    url,
    auth: { username, password },
    log: false,
  });

  await client.login();
  client.setDomain(domainId);

  for (const key of [
    'item',
    'user',
    'role',
    'gameserver',
    'cronjob',
    'function',
    'module',
    'hook',
    'command',
    'player',
    'settings',
    'variable',
    'discord',
    'event',
    'playerOnGameserver',
    'stats',
    'tracking',
    'entity',
    'analytics',
  ] as const) {
    Object.defineProperty(client, key, {
      value: client[key],
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  cachedClient = client;
  return client;
}
