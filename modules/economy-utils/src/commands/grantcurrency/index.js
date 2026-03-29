import { takaro, data, TakaroUserError, checkPermission } from '@takaro/helpers';

async function main() {
  const { pog: granter, arguments: args, gameServerId } = data;

  if (!checkPermission(granter, 'ECONOMY_UTILS_MANAGE_CURRENCY')) {
    throw new TakaroUserError('You do not have permission to manage currency.');
  }

  const receiver = args.receiver;
  const amount = args.amount;

  if (!receiver) throw new TakaroUserError('You must specify a player.');

  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError('Amount must be a positive whole number.');
  }

  const [currencyName, granterName, receiverName] = await Promise.all([
    takaro.settings.settingsControllerGetOne('currencyName', gameServerId).then((r) => r.data.data.value),
    takaro.player.playerControllerGetOne(granter.playerId).then((r) => r.data.data.name),
    takaro.player.playerControllerGetOne(receiver.playerId).then((r) => r.data.data.name),
  ]);

  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, receiver.playerId, {
      currency: amount,
    });
  } catch {
    throw new TakaroUserError('Failed to grant currency. Please check the player exists on this server.');
  }

  console.log(`grantcurrency: successfully added ${amount} to ${receiverName}`);

  // Currency operation already succeeded — don't let notification failures propagate
  try {
    const messageToReceiver = takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `Granted ${amount} ${currencyName} by ${granterName}`,
      opts: {
        recipient: {
          gameId: receiver.gameId,
        },
      },
    });
    await Promise.all([
      granter.pm(`You successfully granted ${amount} ${currencyName} to ${receiverName}`),
      messageToReceiver,
    ]);
  } catch (notifyErr) {
    console.error(`grantcurrency: currency granted but notification failed: ${notifyErr}`);
  }
}

await main();
