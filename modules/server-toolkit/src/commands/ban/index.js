import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getCommandTargetPlayer,
  normalizeReason,
  parseBanDurationToken,
  renderTemplate,
} from './server-toolkit-pure.js';
import {
  getPlayerName,
  safeBroadcast,
} from './server-toolkit-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'TOOLKIT_BAN')) {
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
  const reason = normalizeReason(args.reason, 'Banned by an admin.');

  const payload = {
    reason,
  };
  if (!parsedDuration.isPermanent) {
    payload.expiresAt = parsedDuration.expiresAt;
  }

  console.log(`toolkit:ban payload=${JSON.stringify(payload)}`);

  try {
    await takaro.gameserver.gameServerControllerBanPlayer(gameServerId, target.playerId, payload);
  } catch (err) {
    console.error(`toolkit:ban failed for target=${target.playerId}: ${err}`);
    throw new TakaroUserError('The ban could not be created right now. Please try again in a moment.');
  }

  console.log(`toolkit:ban admin=${adminName} target=${targetName} duration=${parsedDuration.humanDuration} reason=${reason}`);

  const confirmationMessage = parsedDuration.isPermanent
    ? `Banned ${targetName} permanently. Reason: ${reason}`
    : `Banned ${targetName} for ${parsedDuration.humanDuration}. Reason: ${reason}`;

  console.log(`toolkit:ban pm=${confirmationMessage}`);
  try {
    await pog.pm(confirmationMessage);
  } catch (err) {
    console.error(`toolkit:ban pm failed: ${err}`);
  }

  if (mod.userConfig.broadcastBans) {
    // Use separate templates for perm vs temp to avoid "for permanently" grammar issue
    let message;
    if (parsedDuration.isPermanent) {
      const permTemplate = mod.userConfig.banPermBroadcastMessage || '{player} was permanently banned by {admin}. Reason: {reason}';
      message = renderTemplate(permTemplate, {
        player: targetName,
        reason,
        admin: adminName,
      });
    } else {
      message = renderTemplate(mod.userConfig.banBroadcastMessage, {
        player: targetName,
        reason,
        admin: adminName,
        duration: parsedDuration.humanDuration,
      });
    }
    await safeBroadcast(gameServerId, message);
  }
}

await main();
