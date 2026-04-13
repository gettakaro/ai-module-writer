import { data, takaro } from '@takaro/helpers';
import {
  acquireExecutionLock,
  computeFingerprint,
  getFingerprint,
  getInitialState,
  getIntervalStatus,
  getNextSelection,
  getState,
  normalizeInterval,
  normalizeMessages,
  normalizeOrder,
  releaseExecutionLock,
  renderPlaceholders,
  startExecutionLockHeartbeat,
  setFingerprint,
  setState,
} from './server-message-helpers.js';

async function countOnlinePlayers(gameServerId) {
  const pageSize = 100;
  const firstPage = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      online: [true],
    },
    limit: pageSize,
    page: 0,
  });

  const total = firstPage.data.meta?.total;
  if (typeof total === 'number') {
    return total;
  }

  let count = firstPage.data.data.length;
  let page = 1;
  let pageLength = firstPage.data.data.length;

  while (pageLength === pageSize) {
    const nextPage = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      limit: pageSize,
      page,
    });

    pageLength = nextPage.data.data.length;
    count += pageLength;
    page += 1;
  }

  return count;
}

async function main() {
  const { gameServerId, module: mod } = data;
  const order = normalizeOrder(mod.userConfig.order);
  const interval = normalizeInterval(mod.userConfig.interval);
  const messages = normalizeMessages(mod.userConfig.messages);

  if (messages.length === 0) {
    console.log('server-messages: no messages configured, skipping without advancing state');
    return;
  }

  const intervalStatus = getIntervalStatus(interval);
  if (!intervalStatus.valid) {
    throw new Error(
      `server-messages: invalid interval=${JSON.stringify(interval)}. Use a valid five-field UTC cron expression.`,
    );
  }

  if (!intervalStatus.matches) {
    console.log(
      `server-messages: interval=${JSON.stringify(intervalStatus.normalized)} not due at=${new Date().toISOString()}, skipping without advancing state`,
    );
    return;
  }

  const lockToken = await acquireExecutionLock(gameServerId, mod.moduleId);
  if (!lockToken) {
    console.log('server-messages: another execution already holds the rotation lock, skipping without advancing state');
    return;
  }

  const stopLockHeartbeat = startExecutionLockHeartbeat(gameServerId, mod.moduleId, lockToken);

  try {
    const fingerprint = computeFingerprint(order, messages);
    let state = await getState(gameServerId, mod.moduleId);
    const storedFingerprint = await getFingerprint(gameServerId, mod.moduleId);

    if (storedFingerprint !== fingerprint) {
      state = getInitialState(order, messages);
      await Promise.all([
        setState(gameServerId, mod.moduleId, state),
        setFingerprint(gameServerId, mod.moduleId, fingerprint),
      ]);
      console.log(`server-messages: config fingerprint changed, reset rotation state (order=${order})`);
    }

    const [serverResult, playerCount] = await Promise.all([
      takaro.gameserver.gameServerControllerGetOne(gameServerId),
      countOnlinePlayers(gameServerId),
    ]);
    if (playerCount === 0) {
      console.log('server-messages: no players online, skipping without advancing state');
      return;
    }

    const selection = getNextSelection(order, messages, state);
    if (!selection) {
      console.log('server-messages: no message selection available, skipping');
      return;
    }

    const message = messages[selection.messageIndex];
    const serverName = serverResult.data.data.name ?? '';
    const rendered = renderPlaceholders(message.text, {
      playerCount,
      serverName,
    });

    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: rendered,
    });

    await setState(gameServerId, mod.moduleId, selection.nextState);

    if (order === 'random') {
      console.log(
        `server-messages: sent order=random messageIndex=${selection.messageIndex} cursor=${selection.cursor} bagSize=${selection.bagSize} rendered=${JSON.stringify(rendered)}`,
      );
      return;
    }

    console.log(
      `server-messages: sent order=sequential messageIndex=${selection.messageIndex} nextIndex=${selection.nextState.index} rendered=${JSON.stringify(rendered)}`,
    );
  } finally {
    await stopLockHeartbeat().catch((err) => {
      console.error(`server-messages: failed to stop execution lock heartbeat: ${err}`);
    });
    await releaseExecutionLock(gameServerId, mod.moduleId, lockToken).catch((err) => {
      console.error(`server-messages: failed to release execution lock: ${err}`);
    });
  }
}

await main();
