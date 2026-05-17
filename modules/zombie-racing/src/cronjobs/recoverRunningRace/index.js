import { data, takaro } from '@takaro/helpers';
import { getRaceLabels, recoverRunningRace } from './utils.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const labels = getRaceLabels(mod.userConfig);
  const { result, skipped } = await recoverRunningRace(gameServerId, mod.moduleId, mod.userConfig, mod.systemConfig);

  if (skipped || !result) {
    console.log('racing:recoverRunningRace skipped');
    return;
  }

  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `${labels.raceName} #${result.raceNumber} recovery finished. Winner: ${result.winner}.`,
    opts: {},
  });
  console.log(`racing:recoverRunningRace finished race=${result.raceNumber} winner=${result.winner} bets=${result.totalBets}`);
}

await main();
