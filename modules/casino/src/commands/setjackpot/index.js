import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, setJackpot, getJackpot, formatCurrency, sendPlayerMessage } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new TakaroUserError('Jackpot amount must be a number >= 0.');
  const current = await getJackpot(gameServerId, mod.moduleId);
  current.amount = Math.round(amount);
  await setJackpot(gameServerId, mod.moduleId, current);
  await sendPlayerMessage(pog, `💰 Jackpot set to ${formatCurrency(current.amount)} coin.`);
}

await main();
