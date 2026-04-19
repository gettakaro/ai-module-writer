import { data } from '@takaro/helpers';
import {
  getDefaultConfig,
  placeBet,
  settle,
  settleJackpotWin,
  roundCurrency,
  formatCurrency,
  pickSlotSymbol,
  readJsonVariable,
  deleteVariable,
  getSlotSymbolByEmoji,
} from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'slots', amount: args.amount });

  const forcedReels = await readJsonVariable(gameServerId, mod.moduleId, 'casino_slots_override', player.id, null);
  if (forcedReels) {
    await deleteVariable(gameServerId, mod.moduleId, 'casino_slots_override', player.id);
  }

  const reels = Array.isArray(forcedReels?.reels) && forcedReels.reels.length === 3
    ? forcedReels.reels.map((emoji) => getSlotSymbolByEmoji(emoji) ?? pickSlotSymbol())
    : [pickSlotSymbol(), pickSlotSymbol(), pickSlotSymbol()];
  const icons = reels.map((r) => r.emoji).join(' ');
  const allSame = reels[0].emoji === reels[1].emoji && reels[1].emoji === reels[2].emoji;
  const adjacentPair = reels[0].emoji === reels[1].emoji || reels[1].emoji === reels[2].emoji;

  let payout = 0;
  let jackpotWin = false;

  if (allSame && reels[0].emoji === '7️⃣') {
    jackpotWin = true;
  } else if (allSame) {
    payout = roundCurrency(placed.amount * reels[0].triple * (1 - placed.edgeFraction));
  } else if (adjacentPair) {
    payout = roundCurrency(placed.amount * 1.5 * (1 - placed.edgeFraction));
  }

  const result = jackpotWin
    ? await settleJackpotWin({ gameServerId, moduleId: mod.moduleId, player, config, game: 'slots', betAmount: placed.amount })
    : await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'slots', betAmount: placed.amount, payout, jackpotWin });
  if (jackpotWin) {
    payout = roundCurrency(result.payout ?? payout);
  }
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
