import { data, TakaroUserError } from '@takaro/helpers';
import { getDefaultConfig, placeBet, settle, roundCurrency, formatCurrency } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const side = String(args.side ?? '').toLowerCase();
  if (!['heads', 'tails'].includes(side)) {
    throw new TakaroUserError('Pick heads or tails. Usage: /flip <amount> <heads|tails>');
  }

  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'flip', amount: args.amount });
  const flipped = Math.random() < 0.5 ? 'heads' : 'tails';
  const win = flipped === side;
  const payout = win ? roundCurrency(placed.amount * 2 * (1 - placed.edgeFraction)) : 0;
  const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'flip', betAmount: placed.amount, payout });

  if (win) {
    await pog.pm(`🪙 ${flipped.toUpperCase()}! You won ${formatCurrency(payout)} coin. (Balance: ${formatCurrency(result.balance)})`);
  } else {
    await pog.pm(`🪙 ${flipped.toUpperCase()}. You lost ${formatCurrency(placed.amount)} coin. (Balance: ${formatCurrency(result.balance)})`);
  }
}

await main();
