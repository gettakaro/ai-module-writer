import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  extractReason,
  getCommandTargetPlayer,
  getOnlinePogForPlayer,
  getPlayerName,
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

  if (target.playerId === player.id) {
    throw new TakaroUserError('You cannot use this command on yourself.');
  }

  const onlineTarget = await getOnlinePogForPlayer(gameServerId, target.playerId);
  if (!onlineTarget?.gameId) {
    throw new TakaroUserError('That player is not currently online.');
  }

  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);
  const reason = normalizeReason(extractReason(args.reason, chatMessage, [targetName]), 'Kicked by an admin.');

  await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, onlineTarget.playerId, {
    reason,
  });

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
