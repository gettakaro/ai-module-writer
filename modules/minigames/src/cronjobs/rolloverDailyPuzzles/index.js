import { data } from '@takaro/helpers';
import { rolloverDailyPuzzles } from './minigames-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  await rolloverDailyPuzzles(gameServerId, mod.moduleId);
}

await main();
