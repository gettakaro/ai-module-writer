import { data, takaro } from '@takaro/helpers';
import {
  computeFingerprint,
  getFingerprint,
  getInitialState,
  getNextSelection,
  getState,
  normalizeMessages,
  normalizeOrder,
  renderPlaceholders,
  setFingerprint,
  setState,
} from './server-message-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const order = normalizeOrder(mod.userConfig.order);
  const messages = normalizeMessages(mod.userConfig.messages);
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

  if (messages.length === 0) {
    console.log('server-messages: no messages configured, skipping without advancing state');
    return;
  }

  const [serverResult, playerResult] = await Promise.all([
    takaro.gameserver.gameServerControllerGetOne(gameServerId),
    takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      limit: 1,
      page: 0,
    }),
  ]);

  const playerCount = playerResult.data.meta?.total ?? playerResult.data.data.length;
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
      `server-messages: sent order=random messageIndex=${selection.messageIndex} cursor=${selection.cursor} bag=${JSON.stringify(selection.bag)} rendered=${JSON.stringify(rendered)}`,
    );
    return;
  }

  console.log(
    `server-messages: sent order=sequential messageIndex=${selection.messageIndex} nextIndex=${selection.nextState.index} rendered=${JSON.stringify(rendered)}`,
  );
}

await main();
