import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const cooldown = mod.userConfig.cooldown ?? 60;
  const tpbackEnabled = mod.userConfig.tpbackEnabled ?? true;

  if (!tpbackEnabled) {
    throw new TakaroUserError('The /tpback command is disabled on this server.');
  }

  // Load saved tpback position
  const tpbackRes = await takaro.variable.variableControllerSearch({
    filters: { key: ['tpback'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
  });
  const tpbackVar = tpbackRes.data.data[0];
  if (!tpbackVar) {
    throw new TakaroUserError('No previous location saved. Use /tp first to save a return point.');
  }

  let prev;
  try { prev = JSON.parse(tpbackVar.value); } catch {
    throw new TakaroUserError('Your saved location data is corrupted. Please use /tp to reset it.');
  }

  // Enforce cooldown
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

  // Save current position as new tpback so they can chain back
  const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, pog.playerId);
  const pos = pogRes.data.data;
  if (pos.positionX != null) {
    const newTpback = JSON.stringify({ x: pos.positionX, y: pos.positionY, z: pos.positionZ });
    await takaro.variable.variableControllerUpdate(tpbackVar.id, { value: newTpback });
  }

  // Teleport
  await takaro.gameserver.gameServerControllerTeleportPlayer(gameServerId, pog.playerId, { x: prev.x, y: prev.y, z: prev.z });

  // Update cooldown
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

  await pog.pm(`Teleporting back to (${Math.round(prev.x)}, ${Math.round(prev.y)}, ${Math.round(prev.z)})...`);
}

await main();
