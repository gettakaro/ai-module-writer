import { takaro, TakaroUserError } from '@takaro/helpers';

/**
 * Generic variable read helper. Returns the variable record or null if not found.
 * Pass playerId to scope the variable to a specific player.
 */
export async function getVariable(gameServerId, moduleId, key, playerId) {
  const filters = {
    key: [key],
    gameServerId: [gameServerId],
    moduleId: [moduleId],
  };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

/**
 * Generic variable write helper. Creates if not existing, updates if existing.
 * Pass playerId to scope the variable to a specific player.
 */
export async function setVariable(gameServerId, moduleId, key, value, playerId) {
  const existing = await getVariable(gameServerId, moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    const createPayload = {
      key,
      value: serialized,
      gameServerId,
      moduleId,
    };
    if (playerId) createPayload.playerId = playerId;
    await takaro.variable.variableControllerCreate(createPayload);
  }
}

export async function executeTransfer(
  gameServerId,
  moduleId,
  senderPog,
  receiver,
  amount,
  transferTax,
  currencyName,
  senderName,
  receiverName,
) {
  if (!receiver || !receiver.id || !receiver.playerId || !receiver.gameId)
    throw new TakaroUserError('Invalid receiver data.');

  // Note: DeductCurrency/AddCurrency use playerId; TransactBetweenPlayers uses pog.id (playerOnGameServer ID)
  if (transferTax > 0) {
    // Use Math.ceil so even small transfers pay at least 1 tax when tax > 0
    const taxAmount = Math.ceil(amount * transferTax);
    const receiverAmount = amount - taxAmount;

    // Guard: tax rate 1.0 (or rounding) would send zero to receiver
    if (receiverAmount <= 0) {
      throw new TakaroUserError(
        'Transfer tax would consume the entire amount. No currency would reach the receiver.',
      );
    }

    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, senderPog.playerId, {
        currency: amount,
      });
    } catch {
      throw new TakaroUserError('Insufficient balance to complete this transfer.');
    }

    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, receiver.playerId, {
        currency: receiverAmount,
      });
    } catch (err) {
      // Refund sender since we already deducted from them
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, senderPog.playerId, {
          currency: amount,
        });
      } catch (refundErr) {
        console.error(`Failed to refund sender after failed transfer: ${refundErr}`);
        // Persist a record of the failed refund so admins can investigate and manually correct it
        const failedRefundKey = `failed-refund-${senderPog.playerId}-${Date.now()}`;
        try {
          await takaro.variable.variableControllerCreate({
            key: failedRefundKey,
            value: JSON.stringify({
              player: senderPog.playerId,
              amount,
              timestamp: new Date().toISOString(),
              error: String(refundErr),
            }),
            gameServerId,
            moduleId,
          });
        } catch (persistErr) {
          console.error(`Failed to persist refund audit record: ${persistErr}`);
        }
      }
      // Honest message: refund was attempted but may not have succeeded
      throw new TakaroUserError(
        'Transfer failed. A refund was attempted but may not have succeeded. Please check your balance.',
      );
    }

    console.log(
      `Transfer with tax: successfully transferred ${amount} ${currencyName} to ${receiverName} (${taxAmount} ${currencyName} tax, ${receiverAmount} ${currencyName} received)`,
    );

    // Notifications — wrap so a failed PM doesn't undo the already-completed transfer
    try {
      const messageToReceiver = takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `You received ${receiverAmount} ${currencyName} from ${senderName} (${taxAmount} ${currencyName} tax applied)`,
        opts: {
          recipient: {
            gameId: receiver.gameId,
          },
        },
      });
      await Promise.all([
        senderPog.pm(
          `You successfully transferred ${amount} ${currencyName} to ${receiverName} (${taxAmount} ${currencyName} tax, ${receiverAmount} ${currencyName} received)`,
        ),
        messageToReceiver,
      ]);
    } catch (notifyErr) {
      console.error(`Transfer succeeded but notification failed: ${notifyErr}`);
    }
  } else {
    // No tax: use atomic TransactBetweenPlayers
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerTransactBetweenPlayers(
        senderPog.gameServerId,
        senderPog.id,
        receiver.id,
        {
          currency: amount,
        },
      );
    } catch {
      throw new TakaroUserError(
        `Failed to transfer ${amount} ${currencyName} to ${receiverName}. Are you sure you have enough balance?`,
      );
    }

    console.log(`Transfer: successfully transferred ${amount} ${currencyName} to ${receiverName}`);

    // Notifications — wrap so a failed PM doesn't undo the already-completed transfer
    try {
      const messageToReceiver = takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `You received ${amount} ${currencyName} from ${senderName}`,
        opts: {
          recipient: {
            gameId: receiver.gameId,
          },
        },
      });
      await Promise.all([
        senderPog.pm(`You successfully transferred ${amount} ${currencyName} to ${receiverName}`),
        messageToReceiver,
      ]);
    } catch (notifyErr) {
      console.error(`Transfer succeeded but notification failed: ${notifyErr}`);
    }
  }
}
