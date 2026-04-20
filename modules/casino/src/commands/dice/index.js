import { data, TakaroUserError } from '@takaro/helpers';
import { getDefaultConfig, placeBet, settle, roundCurrency, formatCurrency, sendPlayerMessage } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const direction = String(args.direction ?? '').toLowerCase();
  const target = Number(args.target);
  if (!['over', 'under'].includes(direction)) {
    throw new TakaroUserError('Direction must be over or under. Usage: /dice <amount> <over|under> <2-98>');
  }
  if (!Number.isInteger(target) || target < 2 || target > 98) {
    throw new TakaroUserError('Target must be a whole number between 2 and 98.');
  }

  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'dice', amount: args.amount });
  const roll = 1 + Math.floor(Math.random() * 100);
  const p = direction === 'over' ? ((100 - target) / 100) : ((target - 1) / 100);
  const win = direction === 'over' ? roll > target : roll < target;
  const payout = win ? roundCurrency(placed.amount * ((1 - placed.edgeFraction) / p)) : 0;
  const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'dice', betAmount: placed.amount, payout });

  if (win) {
    await sendPlayerMessage(pog, `🎲 Rolled ${roll}. You bet ${direction} ${target} and won ${formatCurrency(payout)} coin. (Balance: ${formatCurrency(result.balance)})`);
  } else {
    await sendPlayerMessage(pog, `🎲 Rolled ${roll}. You bet ${direction} ${target} and lost ${formatCurrency(placed.amount)} coin. (Balance: ${formatCurrency(result.balance)})`);
  }
}

await main();
