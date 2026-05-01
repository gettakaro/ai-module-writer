import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';

async function main() {
  const { pog, gameServerId, module: mod, arguments: args } = data;

  if (!checkPermission(pog, 'TELEPORT_TP_PLAYER')) {
    throw new TakaroUserError('You do not have permission to use /tpplayer.');
  }

  const playerName = args.playerName;
  if (!playerName) {
    throw new TakaroUserError('Usage: /tpplayer <playerName>');
  }

  // Find the target player on this game server by name
  const searchRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], online: [true] },
    extend: ['player'],
  });

  const players = searchRes.data.data;
  const target = players.find(p => {
    const name = p.player?.name ?? '';
    return name.toLowerCase() === playerName.toLowerCase();
  });

  if (!target) {
    throw new TakaroUserError(`Player "${playerName}" not found or is not online.`);
  }

  if (target.positionX == null || target.positionY == null || target.positionZ == null) {
    throw new TakaroUserError(`Could not determine ${playerName}'s position.`);
  }

  // Save caller's current position as tpback
  const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, pog.playerId);
  const pos = pogRes.data.data;
  if (pos.positionX != null) {
    const tpbackRes = await takaro.variable.variableControllerSearch({
      filters: { key: ['tpback'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
    });
    const tpbackVar = tpbackRes.data.data[0];
    const tpbackValue = JSON.stringify({ x: pos.positionX, y: pos.positionY, z: pos.positionZ });
    if (tpbackVar) {
      await takaro.variable.variableControllerUpdate(tpbackVar.id, { value: tpbackValue });
    } else {
      await takaro.variable.variableControllerCreate({
        key: 'tpback', value: tpbackValue, gameServerId, moduleId: mod.moduleId, playerId: pog.playerId,
      });
    }
  }

  // Teleport caller to target's position
  await takaro.gameserver.gameServerControllerTeleportPlayer(gameServerId, pog.playerId, {
    x: target.positionX,
    y: target.positionY,
    z: target.positionZ,
  });

  await pog.pm(`Teleporting to ${playerName}...`);
}

await main();
