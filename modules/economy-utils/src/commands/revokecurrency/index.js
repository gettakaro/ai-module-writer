import { takaro, data, TakaroUserError, checkPermission } from '@takaro/helpers';

async function main() {
  const { pog: revoker, arguments: args, gameServerId } = data;

  if (!checkPermission(revoker, 'ECONOMY_UTILS_MANAGE_CURRENCY')) {
    throw new TakaroUserError('You do not have permission to manage currency.');
  }

  const receiver = args.receiver;
  const amount = args.amount;

  if (!receiver) throw new TakaroUserError('You must specify a player.');

  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError('Amount must be a positive whole number.');
  }

  const [currencyName, revokerName, receiverName] = await Promise.all([
    takaro.settings.settingsControllerGetOne('currencyName', gameServerId).then((r) => r.data.data.value),
    takaro.player.playerControllerGetOne(revoker.playerId).then((r) => r.data.data.name),
    takaro.player.playerControllerGetOne(receiver.playerId).then((r) => r.data.data.name),
  ]);

  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, receiver.playerId, {
      currency: amount,
    });
  } catch {
    throw new TakaroUserError(
      `Failed to revoke ${amount} ${currencyName} from ${receiverName}. They may not have enough balance.`,
    );
  }

  console.log(`revokecurrency: successfully deducted ${amount} from ${receiverName}`);

  // Currency operation already succeeded — don't let notification failures propagate
  try {
    const messageToReceiver = takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `${amount} ${currencyName} were revoked by ${revokerName}`,
      opts: {
        recipient: {
          gameId: receiver.gameId,
        },
      },
    });
    await Promise.all([
      revoker.pm(`You successfully revoked ${amount} ${currencyName} of ${receiverName}'s balance`),
      messageToReceiver,
    ]);
  } catch (notifyErr) {
    console.error(`revokecurrency: currency revoked but notification failed: ${notifyErr}`);
  }
}

await main();
