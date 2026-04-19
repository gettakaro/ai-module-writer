import { data, TakaroUserError, takaro } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, deleteVariable } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const targetName = String(args.player ?? '').trim();
  if (!targetName) throw new TakaroUserError('Usage: /casinoresetstats <player>');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player \"${targetName}\" not found.`);
  await deleteVariable(gameServerId, mod.moduleId, 'casino_stats', target.playerId);

  let page = 0;
  let clearedWindows = 0;
  while (page < 100) {
    const res = await takaro.variable.variableControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        moduleId: [mod.moduleId],
        playerId: [target.playerId],
      },
      search: { key: ['casino_window:'] },
      page,
      limit: 100,
    });
    const batch = res.data.data.filter((row) => row.key.startsWith('casino_window:'));
    for (const row of batch) {
      await takaro.variable.variableControllerDelete(row.id);
      clearedWindows += 1;
    }
    if (res.data.data.length < 100) break;
    page += 1;
  }

  await pog.pm(`🧹 Reset casino stats for ${target.player?.name ?? targetName} and cleared ${clearedWindows} active cap window${clearedWindows === 1 ? '' : 's'}.`);
}

await main();
