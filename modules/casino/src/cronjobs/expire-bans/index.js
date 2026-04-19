import { data } from '@takaro/helpers';
import { sweepExpiredBans } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const expired = await sweepExpiredBans(gameServerId, mod.moduleId);
  console.log(`casino.expireBans: removed ${expired.length} expired bans`);
}

await main();
