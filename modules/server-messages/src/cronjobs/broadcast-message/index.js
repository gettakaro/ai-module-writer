import { data, takaro } from '@takaro/helpers';
import { getMessageIndex, setMessageIndex, resolveTemplates } from './server-messages-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const moduleId = mod.moduleId;
  const config = mod.userConfig ?? {};

  const messages = Array.isArray(config.messages)
    ? config.messages.filter((message) => typeof message === 'string' && message.length > 0)
    : [];
  const mode = config.mode === 'random' ? 'random' : 'sequential';
  const minPlayers = Number.isFinite(config.minPlayers) ? Math.max(0, Math.floor(config.minPlayers)) : 0;

  if (messages.length === 0) {
    console.log('broadcast-message: skipping broadcast because no messages are configured');
    return;
  }

  const onlinePlayersResult = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      online: [true],
    },
    page: 0,
    limit: 1,
  });
  const onlineCount = onlinePlayersResult.data.meta.total;

  console.log(`broadcast-message: onlineCount=${onlineCount}, minPlayers=${minPlayers}, mode=${mode}`);

  if (onlineCount === 0) {
    console.log('broadcast-message: skipping broadcast because no players are online');
    return;
  }

  if (minPlayers > 0 && onlineCount < minPlayers) {
    console.log(
      `broadcast-message: skipping broadcast because onlineCount ${onlineCount} is below minPlayers ${minPlayers}`,
    );
    return;
  }

  let selectedMessage = messages[0];
  let selectedIndex = 0;
  let nextIndex = null;

  if (mode === 'random') {
    selectedIndex = Math.floor(Math.random() * messages.length);
    selectedMessage = messages[selectedIndex] ?? messages[0];
    console.log(`broadcast-message: random index=${selectedIndex}`);
  } else {
    const storedIndex = await getMessageIndex(gameServerId, moduleId);
    selectedIndex = storedIndex % messages.length;
    selectedMessage = messages[selectedIndex] ?? messages[0];
    nextIndex = (selectedIndex + 1) % messages.length;
    console.log(`broadcast-message: sequential index=${selectedIndex} nextIndex=${nextIndex}`);
  }

  const templateVars = {
    playerCount: onlineCount,
  };

  if (selectedMessage.includes('{serverName}')) {
    try {
      const gameServerRes = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
      templateVars.serverName = gameServerRes.data.data?.name ?? 'Unknown Server';
    } catch (err) {
      console.error(`broadcast-message: failed to fetch server name for template resolution. Error: ${err}`);
      templateVars.serverName = 'Unknown Server';
    }
  }

  const resolvedMessage = resolveTemplates(selectedMessage, templateVars);

  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: resolvedMessage,
    opts: {},
  });

  if (mode === 'sequential' && nextIndex !== null) {
    await setMessageIndex(gameServerId, moduleId, nextIndex);
  }

  console.log(`broadcast-message: sent message: ${resolvedMessage}`);
}

await main();
