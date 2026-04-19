import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getPlayerName,
  renderTemplate,
  safeBroadcast,
  safeDirectMessage,
  safePrivateMessage,
} from './utils-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'UTILS_GIVE_CURRENCY')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const target = args.player;
  const amount = args.amount;

  if (!target || !Number.isInteger(amount) || amount <= 0) {
    throw new TakaroUserError('Usage: givecurrency <player> <amount> — Amount must be a positive whole number.');
  }

  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);

  await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, target.playerId, {
    currency: amount,
  });

  console.log(`utils:givecurrency admin=${adminName} target=${targetName} amount=${amount}`);

  await safePrivateMessage(pog, `Gave ${amount} currency to ${targetName}.`);
  await safeDirectMessage(gameServerId, target, `${adminName} gave you ${amount} currency.`);

  if (mod.userConfig.broadcastCurrencyGrants) {
    const message = renderTemplate(mod.userConfig.currencyGrantBroadcastMessage, {
      player: targetName,
      amount,
      admin: adminName,
    });
    await safeBroadcast(gameServerId, message);
  }
}

await main();
