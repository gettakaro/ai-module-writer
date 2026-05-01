import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const now = new Date();

  let page = 0;
  const pageSize = 100;

  while (true) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { gameServerId: [gameServerId] },
      search: { key: ['casino_ban:'] },
      limit: pageSize,
      page,
    });

    const batch = res.data.data.filter(v => v.key.startsWith('casino_ban:'));
    if (!batch.length && page > 0) break;

    for (const v of batch) {
      try {
        const ban = JSON.parse(v.value);
        if (ban.expiresAt && new Date(ban.expiresAt) <= now) {
          await takaro.variable.variableControllerDelete(v.id);
        }
      } catch {}
    }

    if (res.data.data.length < pageSize) break;
    page++;
  }
}
await main();
