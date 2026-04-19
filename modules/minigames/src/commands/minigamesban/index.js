import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { banPlayer, normalizeOptionalNumberArg } from './minigames-helpers.js';

function parseBanHours(args, chatMessage) {
  const rawMessage = String(chatMessage?.msg || chatMessage?.message || '').trim();
  if (rawMessage) {
    const parts = rawMessage.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      return Number(parts[2]);
    }
    return undefined;
  }

  return normalizeOptionalNumberArg(args.hours);
}

async function main() {
  const { gameServerId, pog, module: mod, arguments: args, chatMessage } = data;
  if (!checkPermission(pog, 'MINIGAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage mini-games.');
  const hours = parseBanHours(args, chatMessage);
  const target = await banPlayer({ gameServerId, moduleId: mod.moduleId, targetName: args.player, hours });
  await pog.pm(`🚫 ${target.name} has been banned from mini-games${hours ? ` for ${hours}h` : ''}.`);
}

await main();
