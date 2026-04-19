import { data } from '@takaro/helpers';
import { getDefaultConfig, sweepExpiredSessions } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const actions = await sweepExpiredSessions(gameServerId, mod.moduleId, config);
  console.log(`casino.expireSessions: processed ${actions.length} expired items`);
}

await main();
