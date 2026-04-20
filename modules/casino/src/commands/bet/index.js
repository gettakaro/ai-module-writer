import { data } from '@takaro/helpers';
import { getDefaultConfig, placeBet, settle, settleJackpotWin, roundCurrency, formatCurrency, parseRouletteSelection, rouletteWin, rouletteColor, sendPlayerMessage } from './casino-helpers.js';

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
  const selectionLabel = selection.type === 'number' ? String(selection.value) : String(selection.value).toLowerCase();
  const jackpotEligible = win && selection.type === 'green' && placed.amount >= Math.floor(config.maxBet * placed.vipMultiplier);
  const result = jackpotEligible
    ? await settleJackpotWin({
      gameServerId,
      moduleId: mod.moduleId,
      player,
      config,
      game: 'roulette',
      betAmount: placed.amount,
      basePayout: payout,
    })
    : await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'roulette', betAmount: placed.amount, payout });
  const wonAmount = roundCurrency(result.payout ?? payout);
  const jackpotNote = jackpotEligible ? ' JACKPOT!' : '';
  await sendPlayerMessage(pog, `🎡 You bet on ${selectionLabel}. Spun ${spin} ${rouletteColor(spin).toUpperCase()}.${jackpotNote} ${win ? `You won ${formatCurrency(wonAmount)} coin.` : `You lost ${formatCurrency(placed.amount)} coin.`} (Balance: ${formatCurrency(result.balance)})`);
}

await main();
