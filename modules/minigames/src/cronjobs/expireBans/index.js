import { data } from '@takaro/helpers';
import { expireBans } from './minigames-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  await expireBans(gameServerId, mod.moduleId);
}

await main();
