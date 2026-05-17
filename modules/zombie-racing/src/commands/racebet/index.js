import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { acquireRaceLock, findEntrant, getRaceData, getRaceLabels, parseEntrants, releaseRaceLock, updateRaceData } from './utils.js';

async function main() {
  const { pog, player, gameServerId, module: mod, arguments: args } = data;
  if (!checkPermission(pog, 'RACING_BET')) {
    throw new TakaroUserError('You do not have permission to place race bets.');
  }

  const labels = getRaceLabels(mod.userConfig);
  const racerName = String(args.racer || '').trim();
  const amount = Number(args.amount);
  const minBet = mod.userConfig?.minBet || 50;
  const maxBet = mod.userConfig?.maxBet || 1000;

  if (!racerName) {
    throw new TakaroUserError(`Usage: racebet <${labels.racerTypeLabel}> <amount>.`);
  }
  if (!Number.isInteger(amount) || amount < minBet || amount > maxBet) {
    throw new TakaroUserError(`Bet amount must be a whole number between ${minBet} and ${maxBet}.`);
  }

  const entrants = parseEntrants(mod.userConfig);
  const entrant = findEntrant(entrants, racerName);
  if (!entrant) {
    throw new TakaroUserError(`${labels.racerTypeLabel} "${racerName}" was not found. Available ${labels.racerTypePluralLabel}: ${entrants.map((e) => e.name).join(', ')}.`);
  }

  const currentRaceData = await getRaceData(gameServerId, mod.moduleId);
  if (currentRaceData.status === 'running') {
    throw new TakaroUserError('Betting is closed while the race is running. Please wait for the next race before placing another bet.');
  }
  if (currentRaceData.completion?.raceNumber === currentRaceData.raceNumber) {
    throw new TakaroUserError('This race is being completed. Please wait for the next race before placing another bet.');
  }

  const lockOwner = await acquireRaceLock(gameServerId, mod.moduleId, 'racebet');
  try {
    const raceData = await getRaceData(gameServerId, mod.moduleId);
    if (raceData.status === 'running') {
      throw new TakaroUserError('Betting is closed while the race is running. Please wait for the next race before placing another bet.');
    }
    if (raceData.completion?.raceNumber === raceData.raceNumber) {
      throw new TakaroUserError('This race is being completed. Please wait for the next race before placing another bet.');
    }
    const playerId = pog.playerId || player.id;
    const existingBetIndex = raceData.bets.findIndex((bet) => bet.playerId === playerId);
    const existingBet = existingBetIndex >= 0 ? raceData.bets[existingBetIndex] : null;
    const currentCurrency = pog.currency || 0;
    const availableCurrency = currentCurrency + (existingBet?.amount || 0);

    if (availableCurrency < amount) {
      throw new TakaroUserError(`You don't have enough currency. You have ${currentCurrency}${existingBet ? ` plus ${existingBet.amount} from your existing bet` : ''} but tried to bet ${amount}.`);
    }

    const originalRaceData = {
      ...raceData,
      bets: raceData.bets.map((bet) => ({ ...bet })),
    };
    const newBet = {
      playerId,
      playerName: player.name,
      racer: entrant.name,
      amount,
      odds: entrant.odds,
      placedAt: Date.now(),
    };
    if (existingBetIndex >= 0) {
      raceData.bets.splice(existingBetIndex, 1, newBet);
    } else {
      raceData.bets.push(newBet);
    }
    await updateRaceData(gameServerId, mod.moduleId, raceData);

    const netCurrencyChange = amount - (existingBet?.amount || 0);
    try {
      if (netCurrencyChange > 0) {
        await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, playerId, {
          currency: netCurrencyChange,
        });
      } else if (netCurrencyChange < 0) {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
          currency: Math.abs(netCurrencyChange),
        });
      }
    } catch (err) {
      await updateRaceData(gameServerId, mod.moduleId, originalRaceData);
      console.error(`racing:racebet currency update failed after race state write for player=${player.name}. Error: ${err}`);
      throw new TakaroUserError('Unable to place your race bet because the currency update failed. Your previous bet was restored.');
    }

    if (existingBet) {
      await pog.pm(`Replaced your previous ${existingBet.amount} bet on ${existingBet.racer}.`);
      if (netCurrencyChange < 0) {
        await pog.pm(`Refunded ${Math.abs(netCurrencyChange)} from your previous bet.`);
      }
    }

    const potentialWin = Math.floor(amount * entrant.odds);
    await pog.pm(`Bet placed: ${amount} on ${entrant.name} (${entrant.odds}:1 odds). Potential winnings: ${potentialWin}.`);
    await pog.pm(`Race #${raceData.raceNumber} now has ${raceData.bets.length} bet${raceData.bets.length === 1 ? '' : 's'}.`);
    console.log(`racing:racebet player=${player.name} racer=${entrant.name} amount=${amount} odds=${entrant.odds} race=${raceData.raceNumber} bets=${raceData.bets.length}`);
  } finally {
    await releaseRaceLock(gameServerId, mod.moduleId, lockOwner);
  }
}

await main();
