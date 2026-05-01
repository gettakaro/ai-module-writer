import { data, takaro, TakaroUserError } from '@takaro/helpers';

async function main() {
  const { pog, gameServerId, module: mod, arguments: args } = data;
  const name = args.name;

  const varRes = await takaro.variable.variableControllerSearch({
    filters: { key: ['teleports'], gameServerId: [gameServerId], moduleId: [mod.moduleId], playerId: [pog.playerId] },
  });
  const tpVar = varRes.data.data[0];
  let teleports = [];
  if (tpVar) {
    try { teleports = JSON.parse(tpVar.value); } catch { teleports = []; }
  }

  const idx = teleports.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) {
    throw new TakaroUserError(`Waypoint "${name}" not found. Use /listtp to see your saved waypoints.`);
  }

  teleports.splice(idx, 1);

  if (tpVar) {
    await takaro.variable.variableControllerUpdate(tpVar.id, { value: JSON.stringify(teleports) });
  }

  await pog.pm(`Waypoint "${name}" deleted. You now have ${teleports.length} waypoint(s) saved.`);
}

await main();
