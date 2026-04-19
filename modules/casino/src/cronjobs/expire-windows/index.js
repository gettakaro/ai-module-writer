import { data } from '@takaro/helpers';
import { getDefaultConfig, sweepExpiredWindows } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const deleted = await sweepExpiredWindows(gameServerId, mod.moduleId, config);
  console.log(`casino.expireWindows: deleted ${deleted} old window rows`);
}

await main();
