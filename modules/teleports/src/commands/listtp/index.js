import { data, takaro } from '@takaro/helpers';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const maxPoints = mod.userConfig.maxTeleportPoints ?? 3;

  const varRes = await takaro.variable.variableControllerSearch({
    filters: { key: ['teleports'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
  });
  const tpVar = varRes.data.data[0];
  let teleports = [];
  if (tpVar) {
    try { teleports = JSON.parse(tpVar.value); } catch { teleports = []; }
  }

  // Account for TELEPORT_EXTRA_POINTS
  const extraPerm = pog.roles?.flatMap(r => r.permissions ?? []).find(p => p.permission?.permission === 'TELEPORT_EXTRA_POINTS');
  const effectiveMax = maxPoints + (extraPerm?.count ?? 0);

  if (teleports.length === 0) {
    await pog.pm(`You have no saved waypoints (0/${effectiveMax}). Use /settp <name> to save your current location.`);
    return;
  }

  const lines = teleports.map(
    (t, i) => `${i + 1}. ${t.name} (${Math.round(t.x)}, ${Math.round(t.y)}, ${Math.round(t.z)})`
  );

  await pog.pm(`Your waypoints (${teleports.length}/${effectiveMax}):\n${lines.join('\n')}`);
}

await main();
