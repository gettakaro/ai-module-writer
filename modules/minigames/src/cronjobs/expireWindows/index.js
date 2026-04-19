import { data } from '@takaro/helpers';
import { expireWindows } from './minigames-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  await expireWindows(gameServerId, mod.moduleId);
}

await main();
