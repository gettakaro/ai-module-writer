import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getCommandTargetPlayer,
  normalizeReason,
  renderTemplate,
} from './server-toolkit-pure.js';
import {
  getPlayerName,
  safeBroadcast,
} from './server-toolkit-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'TOOLKIT_KICK')) {
    throw new TakaroUserError('You do not have permission to use this command.');
  }

  const target = getCommandTargetPlayer(args.player);
  if (!target) {
    throw new TakaroUserError('Please specify a valid player to kick.');
  }

  if (!target.online) {
    throw new TakaroUserError('That player is not currently online.');
  }

  if (target.playerId === player.id) {
    throw new TakaroUserError('You cannot use this command on yourself.');
  }

  const [adminName, targetName] = await Promise.all([
    getPlayerName(player.id, player.name),
    getPlayerName(target.playerId, target.name),
  ]);
  const reason = normalizeReason(args.reason, 'Kicked by an admin.');

  try {
    await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, target.playerId, {
      reason,
    });
  } catch (err) {
    console.error(`toolkit:kick failed for target=${target.playerId}: ${err}`);
    throw new TakaroUserError('That player could not be kicked right now. They may have just disconnected, or the game server rejected the kick.');
  }

  console.log(`toolkit:kick admin=${adminName} target=${targetName} reason=${reason}`);

  const kickPm = `Kicked ${targetName}. Reason: ${reason}`;
  console.log(`toolkit:kick pm=${kickPm}`);
  try {
    await pog.pm(kickPm);
  } catch (err) {
    console.error(`toolkit:kick pm failed: ${err}`);
  }

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
