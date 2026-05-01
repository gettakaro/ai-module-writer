import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const cfg = data.module.userConfig;
  const capWindow = cfg.capWindow ?? 'daily';
  const gameServerId = data.gameServerId;

  function getCurrentWindowKey() {
    const now = new Date();
    if (capWindow === 'weekly') {
      const jan1 = new Date(now.getFullYear(), 0, 1);
      const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    return now.toISOString().slice(0, 10);
  }

  const currentKey = getCurrentWindowKey();

  // Paginate all casino_window variables
  let page = 0;
  const pageSize = 100;
  let deleted = 0;

  while (true) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { gameServerId: [gameServerId] },
      search: { key: ['casino_window:'] },
      limit: pageSize,
      page,
    });

    const batch = res.data.data.filter(v => v.key.startsWith('casino_window:'));
    if (!batch.length && page > 0) break;

    for (const v of batch) {
      // Key format: casino_window:{playerId}:{windowKey}
      const parts = v.key.split(':');
      if (parts.length < 3) continue;
      const windowKeyInVar = parts[parts.length - 1];
      if (windowKeyInVar !== currentKey) {
        await takaro.variable.variableControllerDelete(v.id);
        deleted++;
      }
    }

    if (res.data.data.length < pageSize) break;
    page++;
  }
}
await main();
