import { data, takaro } from '@takaro/helpers';
import { finishRace, getRaceLabels } from './utils.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const labels = getRaceLabels(mod.userConfig);
  const { result, skipped } = await finishRace(gameServerId, mod.moduleId, mod.userConfig, mod.systemConfig, 'manual');

  if (skipped || !result) {
    console.log('racing:finishRace skipped hook=finishRaceAfterManualStart');
    return;
  }

  const topThree = (result.results || []).slice(0, 3).map((entrant, index) => `${index + 1}. ${entrant.name}`).join(', ');
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `${labels.raceName} #${result.raceNumber} is complete. Winner: ${result.winner}.`,
    opts: {},
  });
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `Final standings: ${topThree}.`,
    opts: {},
  });
  if (result.totalBets === 0) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: 'No bets were placed.',
      opts: {},
    });
  } else if (result.winners.length > 0) {
    const winnerLines = result.winners
      .map((bet) => `${bet.playerName} (+${bet.payout})`)
      .join(', ');
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `Bet on ${result.winner} and won: ${winnerLines}.`,
      opts: {},
    });
  } else {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `Nobody bet on ${result.winner}. House wins this race.`,
      opts: {},
    });
  }
  console.log(`racing:finishRace hook=finishRaceAfterManualStart race=${result.raceNumber} winner=${result.winner} bets=${result.totalBets} payout=${result.totalPayout}`);
}

await main();
