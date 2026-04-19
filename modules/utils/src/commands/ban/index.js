import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  extractReason,
  getCommandArgumentTokens,
  getCommandTargetPlayer,
  getPlayerName,
  normalizeReason,
  parseBanDurationToken,
  renderTemplate,
  safeBroadcast,
  safePrivateMessage,
} from './utils-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod, chatMessage } = data;

  if (!checkPermission(pog, 'UTILS_BAN')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const target = getCommandTargetPlayer(args.player);
  if (!target) {
    throw new TakaroUserError('Please specify a valid player.');
  }

  if (target.playerId === player.id) {
    throw new TakaroUserError('You cannot use this command on yourself.');
  }

  const parsedDuration = parseBanDurationToken(args.duration);
  if (!parsedDuration) {
    throw new TakaroUserError('Invalid duration. Use perm/permanent or a value like 10m, 12h, 7d, or 2w.');
  }

  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);
  const [targetToken] = getCommandArgumentTokens(chatMessage);
  const reason = normalizeReason(extractReason(args.reason, chatMessage, [targetToken, args.duration]), 'Banned by an admin.');

  const payload = {
    gameServerId,
    playerId: target.playerId,
    reason,
    isGlobal: false,
    takaroManaged: true,
  };
  if (!parsedDuration.isPermanent) {
    payload.until = parsedDuration.expiresAt;
  }

  console.log(`utils:ban payload=${JSON.stringify(payload)}`);

  let banResult;
  try {
    banResult = await takaro.player.banControllerCreate(payload);
  } catch (err) {
    console.error(`utils:ban failed for target=${target.playerId}: ${err}`);
    throw new TakaroUserError('The ban could not be created right now. Please try again or check the server logs.');
  }

  console.log(`utils:ban result=${JSON.stringify(banResult.data.data)}`);
  console.log(`utils:ban admin=${adminName} target=${targetName} duration=${parsedDuration.humanDuration} reason=${reason}`);

  const confirmationMessage = parsedDuration.isPermanent
    ? `Banned ${targetName} permanently. Reason: ${reason}`
    : `Banned ${targetName} for ${parsedDuration.humanDuration}. Reason: ${reason}`;

  await safePrivateMessage(pog, confirmationMessage);

  if (mod.userConfig.broadcastBans) {
    const message = renderTemplate(mod.userConfig.banBroadcastMessage, {
      player: targetName,
      reason,
      admin: adminName,
      duration: parsedDuration.humanDuration,
    });
    await safeBroadcast(gameServerId, message);
  }
}

await main();
