import { data } from '@takaro/helpers';
import { getJackpot, formatCurrency } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const jackpot = await getJackpot(gameServerId, mod.moduleId);
  const history = jackpot.lastWinner
    ? ` Last hit: ${jackpot.lastWinner} on ${jackpot.lastWinGame} at ${jackpot.lastWinAt}.`
    : ' No jackpot winner yet.';
  await pog.pm(`💰 Jackpot: ${formatCurrency(jackpot.amount)} coin.${history}`);
}

await main();
