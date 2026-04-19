import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getGameServerPogForPlayer,
  getPlayerName,
  renderTemplate,
  resolveCommandTargetPlayer,
  safeBroadcast,
  safeDirectMessage,
  safePrivateMessage,
  trimOrEmpty,
} from './utils-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'UTILS_GIVE_CURRENCY')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const amount = args.amount;
  const targetToken = trimOrEmpty(args.player);

  const target = await resolveCommandTargetPlayer(gameServerId, targetToken, { requireOnline: true });
  if (!target) {
    throw new TakaroUserError('Please specify a valid player.');
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TakaroUserError('Usage: /givecurrency <player> <amount> — Amount must be a positive whole number.');
  }

  const [adminName, targetName, targetPog] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
    getGameServerPogForPlayer(gameServerId, target.playerId),
  ]);

  if (!targetPog?.online) {
    throw new TakaroUserError('That player is not currently online.');
  }

  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, target.playerId, {
      currency: amount,
      reason: `Granted by ${adminName} via /givecurrency`,
    });
  } catch (err) {
    const errorMessage = String(err?.response?.data?.message ?? err?.message ?? err ?? '');
    console.error(`utils:givecurrency failed for target=${target.playerId} amount=${amount}: ${err}`);

    if (/economy|currency is not available|enable economy/i.test(errorMessage)) {
      throw new TakaroUserError('Currency is not available on this game server. Ask an admin to enable economy support before using /givecurrency.');
    }

    throw new TakaroUserError('The currency grant could not be completed because the game server API returned an error. Please try again or check the server logs.');
  }

  console.log(`utils:givecurrency admin=${adminName} target=${targetName} amount=${amount}`);

  await safePrivateMessage(pog, `Gave ${amount} currency to ${targetName}.`);
  await safeDirectMessage(
    gameServerId,
    targetPog,
    `${adminName} gave you ${amount} currency.`,
  );

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
