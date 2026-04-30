import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getCommandTargetPlayer,
  renderTemplate,
} from './server-toolkit-pure.js';
import {
  getPlayerName,
  safeBroadcast,
} from './server-toolkit-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'TOOLKIT_GIVE_CURRENCY')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const amount = args.amount;

  const target = getCommandTargetPlayer(args.player);
  if (!target) {
    throw new TakaroUserError('Please specify a valid player to receive currency.');
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TakaroUserError('Usage: givecurrency <player> <amount> — Amount must be a positive whole number.');
  }

  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);

  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, target.playerId, {
      currency: amount,
    });
  } catch (err) {
    console.error(`toolkit:givecurrency failed for target=${target.playerId} amount=${amount}: ${err}`);
    throw new TakaroUserError('The currency grant could not be completed. Please try again in a moment. If it keeps failing, contact a server owner.');
  }

  console.log(`toolkit:givecurrency admin=${adminName} target=${targetName} amount=${amount}`);

  try {
    await pog.pm(`Gave ${amount} currency to ${targetName}.`);
  } catch (err) {
    console.error(`toolkit:givecurrency pm failed: ${err}`);
  }

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
