import { data, takaro } from '@takaro/helpers';
import { getRaceDurationSeconds, getRaceLabels, startRace } from './utils.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const labels = getRaceLabels(mod.userConfig);
  const raceData = await startRace(gameServerId, mod.moduleId, mod.userConfig, mod.systemConfig, 'scheduled');
  const duration = getRaceDurationSeconds(mod.systemConfig, 'scheduled');

  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `${labels.raceName} #${raceData.raceNumber} has started. Betting is closed; results arrive in about ${duration} seconds.`,
    opts: {},
  });
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `${raceData.frozenBets.length} bet${raceData.frozenBets.length === 1 ? '' : 's'} locked in for this race.`,
    opts: {},
  });

  console.log(`racing:startRace status=running race=${raceData.raceNumber} bets=${raceData.frozenBets.length} finishAt=${raceData.finishAt}`);
}

await main();
