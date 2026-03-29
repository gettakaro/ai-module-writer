import { takaro, data, TakaroUserError } from '@takaro/helpers';
import { executeTransfer, getVariable, setVariable } from './economy-helpers.js';

async function main() {
  const { pog: sender, arguments: args, gameServerId, module: mod } = data;

  const currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', gameServerId)).data.data.value;
  const prefix = (await takaro.settings.settingsControllerGetOne('commandPrefix', gameServerId)).data.data.value;

  const receiver = args.receiver;
  const amount = args.amount;

  // Guard: receiver must be specified
  if (!receiver) throw new TakaroUserError('You must specify a player to transfer to.');

  // Validate amount is a positive integer
  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError('Transfer amount must be a positive whole number.');
  }

  // Prevent self-transfer
  if (sender.playerId === receiver.playerId) {
    throw new TakaroUserError('You cannot transfer currency to yourself.');
  }

  // Check max transfer limit
  if (mod.userConfig.maxTransferAmount > 0 && amount > mod.userConfig.maxTransferAmount) {
    throw new TakaroUserError(
      `You cannot transfer more than ${mod.userConfig.maxTransferAmount} ${currencyName} at once.`,
    );
  }

  const [senderName, receiverName] = await Promise.all([
    takaro.player.playerControllerGetOne(sender.playerId).then((r) => r.data.data.name),
    takaro.player.playerControllerGetOne(receiver.playerId).then((r) => r.data.data.name),
  ]);

  // Check if confirmation is required
  if (mod.userConfig.pendingAmount !== 0 && amount >= mod.userConfig.pendingAmount) {
    // Delete any existing pending transfer for this player before creating a new one
    const existingVar = await getVariable(gameServerId, mod.moduleId, 'confirmTransfer', sender.playerId);
    if (existingVar) {
      await takaro.variable.variableControllerDelete(existingVar.id);
    }

    await setVariable(
      gameServerId,
      mod.moduleId,
      'confirmTransfer',
      {
        amount,
        createdAt: Date.now(),
        receiver: {
          id: receiver.id,
          gameId: receiver.gameId,
          playerId: receiver.playerId,
        },
      },
      sender.playerId,
    );

    console.log(`Pending transfer: ${amount} to ${receiverName}. Awaiting confirmtransfer.`);
    await sender.pm(
      `You are about to send ${amount} ${currencyName} to ${receiverName}. (Please confirm by typing ${prefix}confirmtransfer)`,
    );
    return;
  }

  const tax = mod.userConfig.transferTax || 0;

  await executeTransfer(gameServerId, mod.moduleId, sender, receiver, amount, tax, currencyName, senderName, receiverName);
}

await main();
