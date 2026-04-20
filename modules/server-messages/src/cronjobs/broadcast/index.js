import { data, takaro } from '@takaro/helpers';
import {
  acquireExecutionLock,
  buildConfigFingerprint,
  buildWeightedBag,
  clearDeliveryReceipt,
  createInitialState,
  getDeliveryReceipt,
  getOnlinePlayerCount,
  getServerName,
  getState,
  normalizeMessages,
  normalizeOrder,
  releaseExecutionLock,
  renderMessage,
  setDeliveryReceipt,
  setState,
  shuffleBag,
  startExecutionLockHeartbeat,
} from './server-message-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const lock = await acquireExecutionLock(gameServerId, mod.moduleId);
  let heartbeat = {
    beat: async () => {},
    stop: async () => {},
  };
  let stopError = null;
  let bodyError = null;

  try {
    heartbeat = startExecutionLockHeartbeat(lock);
    const order = normalizeOrder(mod.userConfig?.order);
    const messages = normalizeMessages(mod.userConfig?.messages);
    const fingerprint = buildConfigFingerprint(order, messages);

    let state = await getState(gameServerId, mod.moduleId);
    let shouldPersistState = false;
    const deliveryReceipt = await getDeliveryReceipt(gameServerId, mod.moduleId);

    if (deliveryReceipt?.value?.fingerprint === fingerprint && deliveryReceipt.value?.nextState) {
      await heartbeat.beat('recover-delivery-receipt');
      await setState(gameServerId, mod.moduleId, deliveryReceipt.value.nextState);
      await clearDeliveryReceipt(gameServerId, mod.moduleId);
      console.log('server-messages: recovered rotation state from prior successful broadcast without rebroadcasting');
      return;
    }

    if (deliveryReceipt) {
      await heartbeat.beat('clear-stale-delivery-receipt');
      await clearDeliveryReceipt(gameServerId, mod.moduleId);
      console.log('server-messages: discarded stale delivery receipt due to config change or malformed state');
    }

    if (state.fingerprint !== fingerprint) {
      state = createInitialState(fingerprint);
      shouldPersistState = true;
      console.log('server-messages: config change detected, rotation state reset');
    }

    if (messages.length === 0) {
      if (shouldPersistState) {
        await heartbeat.beat('persist-empty-config-state');
        await setState(gameServerId, mod.moduleId, state);
      }
      console.log('server-messages: no messages configured, skipping broadcast');
      return;
    }

    const onlinePlayerCount = await getOnlinePlayerCount(gameServerId);
    if (onlinePlayerCount === 0) {
      if (shouldPersistState) {
        await heartbeat.beat('persist-no-players-state');
        await setState(gameServerId, mod.moduleId, state);
      }
      console.log('server-messages: no online players, skipping broadcast');
      return;
    }

    let nextState = { ...state };
    let messageIndex;

    if (order === 'random') {
      let bag = Array.isArray(nextState.bag) ? nextState.bag.filter((value) => Number.isInteger(value) && messages[value]) : [];
      let cursor = Number.isInteger(nextState.cursor) && nextState.cursor >= 0 ? nextState.cursor : 0;

      if (bag.length === 0 || cursor >= bag.length) {
        bag = shuffleBag(buildWeightedBag(messages));
        cursor = 0;
        console.log(`server-messages: built new weighted bag with ${bag.length} slots`);
      }

      messageIndex = bag[cursor];
      nextState = {
        ...nextState,
        bag,
        cursor: cursor + 1,
      };
    } else {
      messageIndex = nextState.sequentialIndex % messages.length;
      nextState = {
        ...nextState,
        sequentialIndex: (messageIndex + 1) % messages.length,
        bag: [],
        cursor: 0,
      };
    }

    const selected = messages[messageIndex];
    if (!selected) {
      throw new Error(`server-messages: selected message index ${messageIndex} is invalid`);
    }

    const serverName = await getServerName(gameServerId);
    const renderedMessage = renderMessage(selected.text, {
      playerCount: onlinePlayerCount,
      serverName,
    });

    if (renderedMessage.trim().length === 0) {
      console.warn(`server-messages: rendered message for index=${messageIndex} was blank after placeholder rendering, advancing rotation without broadcast to avoid stalling`);
      await heartbeat.beat('persist-blank-render-state');
      await setState(gameServerId, mod.moduleId, nextState);
      return;
    }

    await heartbeat.beat('before-broadcast');
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: renderedMessage,
    });

    await heartbeat.beat('before-state-persist');
    try {
      await setState(gameServerId, mod.moduleId, nextState);
      await clearDeliveryReceipt(gameServerId, mod.moduleId);
    } catch (persistErr) {
      try {
        await heartbeat.beat('persist-delivery-receipt');
        await setDeliveryReceipt(gameServerId, mod.moduleId, {
          fingerprint,
          nextState,
          messageIndex,
          renderedMessage,
          sentAt: new Date().toISOString(),
        });
      } catch (receiptErr) {
        throw new Error(
          `server-messages: the broadcast was sent, but saving progress failed and the recovery marker could not be recorded. Do not blindly retry this cronjob. Check module variables or Takaro storage health before retrying. State error: ${persistErr}. Recovery marker error: ${receiptErr}`,
        );
      }

      throw new Error(
        `server-messages: the broadcast was sent, but the module could not save its next rotation state. A recovery marker was stored, so the next run should resume without duplicating chat. If this keeps happening, check module variable writes and Takaro storage health. Cause: ${persistErr}`,
      );
    }
    console.log(
      `server-messages: broadcasted order=${order} index=${messageIndex} playerCount=${onlinePlayerCount} message=${renderedMessage}`,
    );
  } catch (err) {
    bodyError = err;
    throw err;
  } finally {
    try {
      await heartbeat.stop();
    } catch (err) {
      stopError = err;
      console.warn(`server-messages: failed to stop execution lock heartbeat cleanly after cronjob completion: ${err}`);
    }

    await releaseExecutionLock(lock);

    if (stopError && !bodyError) {
      throw stopError;
    }
  }
}

await main();
