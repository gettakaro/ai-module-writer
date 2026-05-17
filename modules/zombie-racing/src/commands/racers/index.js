import { data, TakaroUserError } from '@takaro/helpers';
import { getRaceData, getRaceLabels, getStartCronTemporalValue, getTimeUntilRace, nextCronJobRun, parseEntrants } from './utils.js';

async function main() {
  try {
    const { pog, gameServerId, module: mod } = data;
    const labels = getRaceLabels(mod.userConfig);
    const entrants = parseEntrants(mod.userConfig);
    const raceData = await getRaceData(gameServerId, mod.moduleId);
    const minBet = mod.userConfig?.minBet || 50;
    const maxBet = mod.userConfig?.maxBet || 1000;

    const isRunning = raceData.status === 'running';
    const displayEntrants = isRunning && Array.isArray(raceData.frozenEntrants) ? raceData.frozenEntrants : entrants;
    const displayBets = isRunning && Array.isArray(raceData.frozenBets) ? raceData.frozenBets : raceData.bets;
    if (isRunning) {
      await pog.pm(`${labels.raceName}: Race #${raceData.raceNumber} is running. Results arrive in ${getTimeUntilRace(raceData.finishAt)}.`);
    } else {
      await pog.pm(`${labels.raceName}: Race #${raceData.raceNumber} starts in ${getTimeUntilRace(nextCronJobRun(getStartCronTemporalValue(mod.systemConfig)))}.`);
    }
    await pog.pm(`Available ${labels.racerTypePluralLabel}:`);
    for (const entrant of displayEntrants) {
      const betCount = displayBets.filter((bet) => bet.racer.toLowerCase() === entrant.name.toLowerCase()).length;
      await pog.pm(`${entrant.name} - ${entrant.odds}:1 odds${betCount > 0 ? ` (${betCount} bets)` : ''}`);
    }
    if (isRunning) {
      await pog.pm('Betting is closed until the next race.');
    } else {
      await pog.pm(`Bet range: ${minBet}-${maxBet}. Use /racebet <${labels.racerTypeLabel}> <amount>.`);
    }
    console.log(`racing:racers status=${isRunning ? 'running' : 'betting'} raceName="${labels.raceName}" label=${labels.racerTypePluralLabel} entrants=${displayEntrants.map((entrant) => `${entrant.name}:${entrant.odds}`).join('|')} minBet=${minBet} maxBet=${maxBet} bets=${displayBets.length}`);
  } catch (err) {
    console.error(`racing:racers failed: ${err}`);
    throw new TakaroUserError('Unable to load race information. Please try again.');
  }
}

await main();
