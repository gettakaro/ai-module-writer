import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  extractReason,
  getCommandArgumentTokens,
  getCommandTargetPlayer,
  getPlayerName,
  isPlayerOnlineHere,
  normalizeReason,
  renderTemplate,
  safeBroadcast,
  safePrivateMessage,
} from './utils-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod, chatMessage } = data;

  if (!checkPermission(pog, 'UTILS_KICK')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const target = getCommandTargetPlayer(args.player);
  if (!target) {
    throw new TakaroUserError('Please specify a valid player.');
  }

  if (!isPlayerOnlineHere(target, gameServerId)) {
    throw new TakaroUserError('That player is not currently online.');
  }

  if (target.playerId === player.id) {
    throw new TakaroUserError('You cannot use this command on yourself.');
  }

  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);
  const [targetToken] = getCommandArgumentTokens(chatMessage);
  const reason = normalizeReason(extractReason(args.reason, chatMessage, [targetToken]), 'Kicked by an admin.');

  try {
    await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, target.playerId, {
      reason,
    });
  } catch (err) {
    console.error(`utils:kick failed for target=${target.playerId}: ${err}`);
    throw new TakaroUserError('That player could not be kicked right now. They may have just disconnected, or the game server rejected the kick.');
  }

  console.log(`utils:kick admin=${adminName} target=${targetName} reason=${reason}`);

  await safePrivateMessage(pog, `Kicked ${targetName}. Reason: ${reason}`);

  if (mod.userConfig.broadcastKicks) {
    const message = renderTemplate(mod.userConfig.kickBroadcastMessage, {
      player: targetName,
      reason,
      admin: adminName,
    });
    await safeBroadcast(gameServerId, message);
  }
}

await main();
