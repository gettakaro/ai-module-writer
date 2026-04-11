import { data, takaro } from '@takaro/helpers';
import { getMessageIndex, setMessageIndex, resolveTemplates } from './server-messages-helpers.js';

function normalizeConfig(userConfig = {}) {
  const messages = Array.isArray(userConfig.messages)
    ? userConfig.messages.filter((msg) => typeof msg === 'string').map((msg) => msg.trim()).filter(Boolean)
    : [];

  const mode = userConfig.mode === 'random' ? 'random' : 'sequential';
  const minPlayers = Number.isFinite(userConfig.minPlayers) && userConfig.minPlayers > 0
    ? Math.floor(userConfig.minPlayers)
    : 0;

  return { messages, mode, minPlayers };
}

async function main() {
  const { gameServerId, module: mod } = data;
  const { messages, mode, minPlayers } = normalizeConfig(mod.userConfig ?? {});

  if (messages.length === 0) {
    console.log('broadcast-message: skipping — no messages configured');
    return;
  }

  const playerSearch = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      online: [true],
    },
    page: 0,
    limit: 1,
  });

  const onlineCount = playerSearch.data.meta.total ?? 0;
  if (onlineCount === 0) {
    console.log('broadcast-message: skipping — no players online');
    return;
  }

  if (minPlayers > 0 && onlineCount < minPlayers) {
    console.log(
      `broadcast-message: skipping — online player count ${onlineCount} is below minPlayers ${minPlayers}`,
    );
    return;
  }

  let selectedIndex = 0;
  let nextSequentialIndex;
  if (mode === 'random') {
    selectedIndex = Math.floor(Math.random() * messages.length);
  } else {
    const currentIndex = await getMessageIndex(gameServerId, mod.moduleId);
    selectedIndex = currentIndex % messages.length;
    nextSequentialIndex = (selectedIndex + 1) % messages.length;
  }

  let resolvedMessage = messages[selectedIndex];
  const templateVars = {
    playerCount: onlineCount,
  };

  if (resolvedMessage.includes('{serverName}')) {
    const gameServer = (await takaro.gameserver.gameServerControllerGetOne(gameServerId)).data.data;
    templateVars.serverName = gameServer?.name ?? 'Unknown Server';
  }

  resolvedMessage = resolveTemplates(resolvedMessage, templateVars);

  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: resolvedMessage,
    opts: {},
  });

  if (mode === 'sequential') {
    await setMessageIndex(gameServerId, mod.moduleId, nextSequentialIndex);
  }

  console.log(
    `broadcast-message: sent message (mode=${mode}, index=${selectedIndex}, onlineCount=${onlineCount}): ${resolvedMessage}`,
  );
}

await main();
