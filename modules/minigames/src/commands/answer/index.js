import { data } from '@takaro/helpers';
import { getConfig, handleAnswerCommand } from './minigames-helpers.js';

function buildResponse(args, chatMessage) {
  const rawMessage = String(chatMessage?.msg || chatMessage?.message || '').trim();
  if (rawMessage) {
    const firstWhitespace = rawMessage.search(/\s/);
    if (firstWhitespace >= 0) {
      const tail = rawMessage.slice(firstWhitespace).trim();
      if (tail) return tail;
    }
  }

  return Object.keys(args || {})
    .filter((key) => key.startsWith('response'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((key) => String(args[key] ?? '').trim())
    .filter((value) => value && value !== '__MINIGAMES_NONE__')
    .join(' ');
}

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args, chatMessage } = data;
  await handleAnswerCommand({
    gameServerId,
    moduleId: mod.moduleId,
    player,
    pog,
    config: getConfig(mod),
    response: buildResponse(args, chatMessage),
  });
}

await main();
