import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  extractTrailingWords,
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

  const target = args.player;
  if (!target) {
    throw new TakaroUserError('That player is not currently online.');
  }

  if (target.playerId === player.id) {
    throw new TakaroUserError('You cannot use this command on yourself.');
  }

  if (!isPlayerOnlineHere(target, gameServerId)) {
    throw new TakaroUserError('That player is not currently online.');
  }

  const reason = normalizeReason(extractTrailingWords(chatMessage, 2), 'Kicked by an admin.');
  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);

  await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, target.playerId, {
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
