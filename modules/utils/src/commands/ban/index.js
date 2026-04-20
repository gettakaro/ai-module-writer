import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  UTILS_DEBUG_FORCE_BAN_API_FAILURE_KEY,
  consumeUtilsDebugFlag,
  extractReason,
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
    throw new TakaroUserError('Please specify a valid player to ban.');
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
  const reason = normalizeReason(
    extractReason(args.reason, chatMessage, [targetName, target.playerId, args.duration]),
    'Banned by an admin.',
  );

  const payload = {
    reason,
  };
  if (!parsedDuration.isPermanent) {
    payload.expiresAt = parsedDuration.expiresAt;
  }

  console.log(`utils:ban payload=${JSON.stringify(payload)}`);

  let banResult;
  try {
    if (await consumeUtilsDebugFlag(gameServerId, mod.moduleId, UTILS_DEBUG_FORCE_BAN_API_FAILURE_KEY)) {
      throw new Error('Debug-forced ban API failure');
    }

    banResult = await takaro.gameserver.gameServerControllerBanPlayer(gameServerId, target.playerId, payload);
  } catch (err) {
    console.error(`utils:ban failed for target=${target.playerId}: ${err}`);
    throw new TakaroUserError('The ban could not be created right now. Please try again in a moment. If it keeps failing, contact a server owner.');
  }

  console.log(`utils:ban result=${JSON.stringify(banResult.data.data)}`);
  console.log(`utils:ban admin=${adminName} target=${targetName} duration=${parsedDuration.humanDuration} reason=${reason}`);

  const confirmationMessage = parsedDuration.isPermanent
    ? `Banned ${targetName} permanently. Reason: ${reason}`
    : `Banned ${targetName} for ${parsedDuration.humanDuration}. Reason: ${reason}`;

  await safePrivateMessage(pog, confirmationMessage);

  if (mod.userConfig.broadcastBans) {
    const template = String(mod.userConfig.banBroadcastMessage);
    const usesLegacyForPrefix = template.includes('for {duration}');

    const normalizedTemplate = parsedDuration.isPermanent && usesLegacyForPrefix
      ? template.replace(/for\s+\{duration\}/i, 'permanently')
      : template;

    const duration = usesLegacyForPrefix
      ? parsedDuration.humanDuration
      : (parsedDuration.isPermanent ? 'permanently' : `for ${parsedDuration.humanDuration}`);

    const message = renderTemplate(normalizedTemplate, {
      player: targetName,
      reason,
      admin: adminName,
      duration,
    });
    await safeBroadcast(gameServerId, message);
  }
}

await main();
