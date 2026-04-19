import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  extractReason,
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

  const target = args.player;
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

  const reason = normalizeReason(extractReason(args.reason, chatMessage, [target.name, args.duration]), 'Banned by an admin.');
  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);

  const payload = {
    reason,
  };
  if (!parsedDuration.isPermanent) {
    payload.expiresAt = parsedDuration.expiresAt;
  }

  const banResult = await takaro.gameserver.gameServerControllerBanPlayer(gameServerId, target.playerId, payload);

  console.log(`utils:ban result=${JSON.stringify(banResult.data.data)}`);
  console.log(`utils:ban admin=${adminName} target=${targetName} duration=${parsedDuration.humanDuration} reason=${reason}`);

  await safePrivateMessage(pog, `Banned ${targetName} for ${parsedDuration.humanDuration}. Reason: ${reason}`);

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
