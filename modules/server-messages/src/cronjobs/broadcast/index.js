import { data, takaro } from '@takaro/helpers';
import {
  acquireExecutionLock,
  buildConfigFingerprint,
  buildWeightedBag,
  createInitialState,
  getOnlinePlayerCount,
  getServerName,
  getState,
  normalizeMessages,
  normalizeOrder,
  releaseExecutionLock,
  renderMessage,
  setState,
  shuffleBag,
} from './server-message-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const lock = await acquireExecutionLock(gameServerId, mod.moduleId);

  try {
    const order = normalizeOrder(mod.userConfig?.order);
    const messages = normalizeMessages(mod.userConfig?.messages);
    const fingerprint = buildConfigFingerprint(order, messages);

    let state = await getState(gameServerId, mod.moduleId);
    let shouldPersistState = false;

    if (state.fingerprint !== fingerprint) {
      state = createInitialState(fingerprint);
      shouldPersistState = true;
      console.log('server-messages: config change detected, rotation state reset');
    }

    if (messages.length === 0) {
      if (shouldPersistState) {
        await setState(gameServerId, mod.moduleId, state);
      }
      console.log('server-messages: no messages configured, skipping broadcast');
      return;
    }

    const onlinePlayerCount = await getOnlinePlayerCount(gameServerId);
    if (onlinePlayerCount === 0) {
      if (shouldPersistState) {
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

    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: renderedMessage,
    });

    await setState(gameServerId, mod.moduleId, nextState);
    console.log(
      `server-messages: broadcasted order=${order} index=${messageIndex} playerCount=${onlinePlayerCount} message=${renderedMessage}`,
    );
  } finally {
    await releaseExecutionLock(lock?.id);
  }
}

await main();
