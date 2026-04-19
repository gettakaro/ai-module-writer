import { data } from '@takaro/helpers';
import { getDefaultConfig, placeBet, settle, roundCurrency, formatCurrency, pickSlotSymbol, getJackpot, setJackpot } from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'slots', amount: args.amount });

  const reels = [pickSlotSymbol(), pickSlotSymbol(), pickSlotSymbol()];
  const icons = reels.map((r) => r.emoji).join(' ');
  const allSame = reels[0].emoji === reels[1].emoji && reels[1].emoji === reels[2].emoji;
  const adjacentPair = reels[0].emoji === reels[1].emoji || reels[1].emoji === reels[2].emoji;

  let payout = 0;
  let jackpotWin = false;

  if (allSame && reels[0].emoji === '7️⃣') {
    const jackpot = await getJackpot(gameServerId, mod.moduleId);
    payout = roundCurrency(jackpot.amount);
    jackpot.amount = 0;
    jackpot.lastWinner = player.name;
    jackpot.lastWinAt = new Date().toISOString();
    jackpot.lastWinGame = 'slots';
    await setJackpot(gameServerId, mod.moduleId, jackpot);
    jackpotWin = true;
  } else if (allSame) {
    payout = roundCurrency(placed.amount * reels[0].triple * (1 - placed.edgeFraction));
  } else if (adjacentPair) {
    payout = roundCurrency(placed.amount * 1.5 * (1 - placed.edgeFraction));
  }

  const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'slots', betAmount: placed.amount, payout, jackpotWin });
  if (jackpotWin) {
    await pog.pm(`🎰 ${icons} — JACKPOT! Won ${formatCurrency(payout)} coin! (Balance: ${formatCurrency(result.balance)})`);
  } else if (allSame) {
    await pog.pm(`🎰 ${icons} — Triple! Won ${formatCurrency(payout)} coin. (Balance: ${formatCurrency(result.balance)})`);
  } else if (adjacentPair) {
    await pog.pm(`🎰 ${icons} — Pair! Won ${formatCurrency(payout)} coin. (Balance: ${formatCurrency(result.balance)})`);
  } else {
    await pog.pm(`🎰 ${icons} — No luck. Lost ${formatCurrency(placed.amount)} coin. (Balance: ${formatCurrency(result.balance)})`);
  }
}

await main();
