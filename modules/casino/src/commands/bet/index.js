import { data } from '@takaro/helpers';
import { getDefaultConfig, placeBet, settle, roundCurrency, formatCurrency, parseRouletteSelection, rouletteWin, rouletteColor } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const selection = parseRouletteSelection(args.selection);

  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'roulette', amount: args.amount });
  const spin = Math.floor(Math.random() * 37);
  const win = rouletteWin(selection, spin);
  const highPayout = selection.type === 'number' || selection.type === 'green';
  const multiplier = highPayout ? (36 * (1 - placed.edgeFraction)) : (2 * (1 - placed.edgeFraction));
  const payout = win ? roundCurrency(placed.amount * multiplier) : 0;
  const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'roulette', betAmount: placed.amount, payout });
  await pog.pm(`🎡 Spun ${spin} ${rouletteColor(spin).toUpperCase()}. ${win ? `You won ${formatCurrency(payout)} coin.` : `You lost ${formatCurrency(placed.amount)} coin.`} (Balance: ${formatCurrency(result.balance)})`);
}

await main();
