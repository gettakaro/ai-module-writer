import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  UTILS_DEBUG_FORCE_BAN_API_FAILURE_KEY,
  consumeUtilsDebugFlag,
  extractReason,
  getCommandArgumentTokens,
  getPlayerName,
  normalizeReason,
  parseBanDurationToken,
  renderTemplate,
  requireResolvedPlayerArgument,
  safeBroadcast,
  safePrivateMessage,
} from './utils-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod, chatMessage } = data;

  if (!checkPermission(pog, 'UTILS_BAN')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const target = requireResolvedPlayerArgument(args.player);
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
  const [typedTargetToken] = getCommandArgumentTokens(chatMessage);
  const reason = normalizeReason(extractReason(args.reason, chatMessage, [typedTargetToken, args.duration]), 'Banned by an admin.');

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
    if (await consumeUtilsDebugFlag(gameServerId, mod.moduleId, UTILS_DEBUG_FORCE_BAN_API_FAILURE_KEY)) {
      throw new Error('Debug-forced ban API failure');
    }

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
    const template = mod.userConfig.banBroadcastMessage;
    const usesLegacyForPrefix = String(template).includes('for {duration}');
    const duration = usesLegacyForPrefix
      ? parsedDuration.humanDuration
      : (parsedDuration.isPermanent ? 'permanently' : `for ${parsedDuration.humanDuration}`);

    const message = renderTemplate(template, {
      player: targetName,
      reason,
      admin: adminName,
      duration,
    });
    await safeBroadcast(gameServerId, message);
  }
}

await main();
