import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';

async function main() {
  const { pog, gameServerId, module: mod, arguments: args } = data;
  const name = args.name;
  const maxPoints = mod.userConfig.maxTeleportPoints ?? 3;

  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new TakaroUserError('Invalid name. Use only letters, numbers, underscores, and hyphens.');
  }
  if (name.length > 20) {
    throw new TakaroUserError('Name is too long. Maximum 20 characters.');
  }

  // Get current position from the player record
  const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, pog.playerId);
  const pos = pogRes.data.data;

  if (pos.positionX == null || pos.positionY == null || pos.positionZ == null) {
    throw new TakaroUserError('Could not read your position. Make sure you are fully in-game.');
  }

  // Load existing waypoints
  const varRes = await takaro.variable.variableControllerSearch({
    filters: { key: ['teleports'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
  });
  const existingVar = varRes.data.data[0];
  let teleports = [];
  if (existingVar) {
    try { teleports = JSON.parse(existingVar.value); } catch { teleports = []; }
  }

  // Account for TELEPORT_EXTRA_POINTS permission
  const extraPerm = pog.roles?.flatMap(r => r.permissions ?? []).find(p => p.permission?.permission === 'TELEPORT_EXTRA_POINTS');
  const effectiveMax = maxPoints + (extraPerm?.count ?? 0);

  const existingIdx = teleports.findIndex(t => t.name.toLowerCase() === name.toLowerCase());

  if (existingIdx === -1 && teleports.length >= effectiveMax) {
    throw new TakaroUserError(
      `You already have ${teleports.length}/${effectiveMax} waypoints saved. Delete one with /deltp <name> first.`
    );
  }

  const coords = { name, x: pos.positionX, y: pos.positionY, z: pos.positionZ };

  if (existingIdx !== -1) {
    teleports[existingIdx] = coords;
  } else {
    teleports.push(coords);
  }

  const newValue = JSON.stringify(teleports);
  if (existingVar) {
    await takaro.variable.variableControllerUpdate(existingVar.id, { value: newValue });
  } else {
    await takaro.variable.variableControllerCreate({
      key: 'teleports', value: newValue, gameServerId, moduleId: mod.moduleId, playerId: pog.playerId,
    });
  }

  const action = existingIdx !== -1 ? 'updated' : 'saved';
  await pog.pm(
    `Waypoint "${name}" ${action} at (${Math.round(pos.positionX)}, ${Math.round(pos.positionY)}, ${Math.round(pos.positionZ)}). You have ${teleports.length}/${effectiveMax} waypoints used.`
  );
}

await main();
