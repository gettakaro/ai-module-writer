import { data, TakaroUserError } from '@takaro/helpers';
import { getDefaultConfig, placeBet, settle, roundCurrency, formatCurrency, makeCrashPoint } from './casino-helpers.js';

function parseCashoutAt(args, chatMessage) {
  const rawMessage = String(chatMessage?.msg ?? chatMessage ?? '').trim();
  const rawToken = rawMessage.split(/\s+/).filter(Boolean)[2];
  const parsedFromChat = rawToken ? Number(rawToken) : NaN;
  const parsedFromArgs = Number(args.cashoutAt);
  const cashoutAt = Number.isFinite(parsedFromChat) ? parsedFromChat : parsedFromArgs;
  return cashoutAt;
}

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod, chatMessage } = data;
  const config = getDefaultConfig(mod.userConfig);
  const cashoutAt = parseCashoutAt(args, chatMessage);
  if (!Number.isFinite(cashoutAt) || cashoutAt < 1.01 || cashoutAt > 1000) {
    throw new TakaroUserError('Cashout target must be between 1.01 and 1000.');
  }

  const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'crash', amount: args.amount });
  const crashPoint = makeCrashPoint(placed.edgeFraction);
  const payout = crashPoint >= cashoutAt ? roundCurrency(placed.amount * cashoutAt) : 0;
  const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'crash', betAmount: placed.amount, payout });

  if (payout > 0) {
    await pog.pm(`🚀 Crashed at ${crashPoint.toFixed(2)}x (you cashed ${cashoutAt.toFixed(2)}x) — won ${formatCurrency(payout)} coin. (Balance: ${formatCurrency(result.balance)})`);
  } else {
    await pog.pm(`🚀 Crashed at ${crashPoint.toFixed(2)}x (you aimed ${cashoutAt.toFixed(2)}x) — lost ${formatCurrency(placed.amount)} coin. (Balance: ${formatCurrency(result.balance)})`);
  }
}

await main();
