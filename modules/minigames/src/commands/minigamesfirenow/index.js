import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { getConfig, maybeFireLiveRound } from './minigames-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const round = await maybeFireLiveRound({
    gameServerId,
    moduleId: mod.moduleId,
    config: getConfig(mod),
    forcedGame: args.game ? String(args.game).trim().toLowerCase() : undefined,
    ignoreThresholds: true,
  });
  if (!round) {
    await pog.pm('Could not fire a round right now. Check content banks or clear the active round first.');
    return;
  }
  await pog.pm(`🚀 Fired ${round.game}.`);
}

await main();
