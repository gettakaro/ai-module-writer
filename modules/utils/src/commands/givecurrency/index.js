import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  UTILS_DEBUG_FORCE_GIVECURRENCY_API_FAILURE_KEY,
  consumeUtilsDebugFlag,
  getOnlinePogForPlayer,
  getPlayerName,
  isEconomyEnabled,
  renderTemplate,
  resolveOnlinePlayerArgument,
  safeBroadcast,
  safeDirectMessage,
  safePrivateMessage,
} from './utils-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'UTILS_GIVE_CURRENCY')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const amount = args.amount;

  const target = await resolveOnlinePlayerArgument(gameServerId, args.player);
  if (!target) {
    throw new TakaroUserError('Please specify a valid player.');
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TakaroUserError('Usage: /givecurrency <player> <amount> — Amount must be a positive whole number.');
  }

  if (!await isEconomyEnabled(gameServerId)) {
    throw new TakaroUserError('Currency is not available on this game server. Ask an admin to enable economy support before using /givecurrency.');
  }

  const [adminName, targetName, targetPog] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
    getOnlinePogForPlayer(gameServerId, target.playerId),
  ]);

  if (!targetPog?.online) {
    throw new TakaroUserError('That player is not currently online.');
  }

  try {
    if (await consumeUtilsDebugFlag(gameServerId, mod.moduleId, UTILS_DEBUG_FORCE_GIVECURRENCY_API_FAILURE_KEY)) {
      throw new Error('Debug-forced givecurrency API failure');
    }

    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(targetPog.gameServerId || gameServerId, target.playerId, {
      currency: amount,
    });
  } catch (err) {
    const errorMessage = String(err?.response?.data?.message ?? err?.message ?? err ?? '');
    console.error(`utils:givecurrency failed for target=${target.playerId} amount=${amount}: ${err}`);

    if (/economy|currency is not available|enable economy|Currency is not enabled/i.test(errorMessage)) {
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
