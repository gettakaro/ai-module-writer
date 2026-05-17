import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { getRaceDurationSeconds, getRaceLabels, startRace } from './utils.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  if (!checkPermission(pog, 'RACING_ADMIN')) {
    throw new TakaroUserError('You need racing admin permission to start races.');
  }

  const labels = getRaceLabels(mod.userConfig);
  const raceData = await startRace(gameServerId, mod.moduleId, mod.userConfig, mod.systemConfig, 'manual');
  const duration = getRaceDurationSeconds(mod.systemConfig, 'manual');
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `${labels.raceName} #${raceData.raceNumber} has started. Betting is closed; results arrive in about ${duration} seconds.`,
    opts: {},
  });
  await pog.pm(`${labels.raceName} #${raceData.raceNumber} started. ${raceData.frozenBets.length} bets are locked in.`);
  console.log(`racing:startrace status=running race=${raceData.raceNumber} bets=${raceData.frozenBets.length} finishAt=${raceData.finishAt}`);
}

await main();
