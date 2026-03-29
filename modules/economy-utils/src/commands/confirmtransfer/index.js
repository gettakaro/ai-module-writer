import { takaro, data, TakaroUserError } from '@takaro/helpers';
import { executeTransfer, getVariable } from './economy-helpers.js';

async function main() {
  const { gameServerId, pog: sender, module: mod } = data;

  const pendingVar = await getVariable(gameServerId, mod.moduleId, 'confirmTransfer', sender.playerId);

  if (!pendingVar) {
    throw new TakaroUserError('You have no pending transfer.');
  }

  const pendingTransfer = JSON.parse(pendingVar.value);

  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  if (pendingTransfer.createdAt && Date.now() - pendingTransfer.createdAt > FIVE_MINUTES_MS) {
    await takaro.variable.variableControllerDelete(pendingVar.id);
    throw new TakaroUserError('Your pending transfer has expired. Please initiate a new transfer.');
  }

  const amount = pendingTransfer.amount;

  const currencyName = await takaro.settings
    .settingsControllerGetOne('currencyName', gameServerId)
    .then((r) => r.data.data.value);

  if (mod.userConfig.maxTransferAmount > 0 && amount > mod.userConfig.maxTransferAmount) {
    await takaro.variable.variableControllerDelete(pendingVar.id);
    throw new TakaroUserError(
      `This transfer of ${amount} ${currencyName} exceeds the current maximum transfer limit of ${mod.userConfig.maxTransferAmount} ${currencyName}. Transfer cancelled.`,
    );
  }

  let freshReceiver;
  try {
    freshReceiver = (
      await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(
        gameServerId,
        pendingTransfer.receiver.playerId,
      )
    ).data.data;
  } catch {
    await takaro.variable.variableControllerDelete(pendingVar.id);
    throw new TakaroUserError('The receiver is no longer available on this server.');
  }

  const [receiverName, senderName] = await Promise.all([
    takaro.player.playerControllerGetOne(pendingTransfer.receiver.playerId).then((r) => r.data.data.name),
    takaro.player.playerControllerGetOne(sender.playerId).then((r) => r.data.data.name),
  ]);

  const tax = mod.userConfig.transferTax || 0;
  // Tax shown here for UX; executeTransfer recalculates internally for consistency
  const taxAmount = tax > 0 ? Math.ceil(amount * tax) : 0;
  const receiverAmount = amount - taxAmount;

  await sender.pm(
    `Confirming transfer of ${amount} ${currencyName} to ${receiverName}. Tax: ${taxAmount} ${currencyName} (${(tax * 100).toFixed(0)}%). Receiver gets: ${receiverAmount} ${currencyName}.`,
  );

  try {
    await executeTransfer(
      gameServerId,
      mod.moduleId,
      sender,
      freshReceiver,
      amount,
      tax,
      currencyName,
      senderName,
      receiverName,
    );
  } catch (err) {
    if (err instanceof TakaroUserError) {
      // Non-transient error — clean up the pending transfer so the player doesn't retry a doomed operation
      try {
        await takaro.variable.variableControllerDelete(pendingVar.id);
      } catch {}
    }
    throw err;
  }

  // On success, delete the pending variable
  await takaro.variable.variableControllerDelete(pendingVar.id);
}

await main();
