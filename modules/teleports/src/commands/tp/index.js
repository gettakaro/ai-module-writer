import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';

async function main() {
  const { pog, gameServerId, module: mod, arguments: args } = data;
  const name = args.name;
  const cooldown = mod.userConfig.cooldown ?? 60;
  const cost = mod.userConfig.cost ?? 0;

  // Enforce cooldown unless player has bypass permission
  if (!checkPermission(pog, 'TELEPORT_BYPASS_COOLDOWN')) {
    const cdRes = await takaro.variable.variableControllerSearch({
      filters: { key: ['cooldown_last'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
    });
    const cdVar = cdRes.data.data[0];
    if (cdVar) {
      const elapsed = (Date.now() - new Date(cdVar.value).getTime()) / 1000;
      if (elapsed < cooldown) {
        const remaining = Math.ceil(cooldown - elapsed);
        throw new TakaroUserError(`Teleport is on cooldown. Wait ${remaining}s before teleporting again.`);
      }
    }
  }

  // Load waypoints
  const varRes = await takaro.variable.variableControllerSearch({
    filters: { key: ['teleports'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
  });
  const tpVar = varRes.data.data[0];
  let teleports = [];
  if (tpVar) {
    try { teleports = JSON.parse(tpVar.value); } catch { teleports = []; }
  }

  const tp = teleports.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (!tp) {
    throw new TakaroUserError(`Waypoint "${name}" not found. Use /listtp to see your saved waypoints.`);
  }

  // Deduct currency cost
  if (cost > 0) {
    const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, pog.playerId);
    const balance = pogRes.data.data.currency ?? 0;
    if (balance < cost) {
      throw new TakaroUserError(`Not enough currency. Teleport costs ${cost} but you only have ${balance}.`);
    }
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, { currency: cost });
  }

  // Save current position as tpback before teleporting
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

  // Perform teleport
  await takaro.gameserver.gameServerControllerTeleportPlayer(gameServerId, pog.playerId, { x: tp.x, y: tp.y, z: tp.z });

  // Update cooldown timestamp
  const cdRes = await takaro.variable.variableControllerSearch({
    filters: { key: ['cooldown_last'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
  });
  const cdVar = cdRes.data.data[0];
  const now = new Date().toISOString();
  if (cdVar) {
    await takaro.variable.variableControllerUpdate(cdVar.id, { value: now });
  } else {
    await takaro.variable.variableControllerCreate({
      key: 'cooldown_last', value: now, gameServerId, moduleId: mod.moduleId, playerId: pog.playerId,
    });
  }

  await pog.pm(`Teleporting to "${tp.name}"...`);
}

await main();
