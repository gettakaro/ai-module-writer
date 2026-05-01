import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;

  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }

  if (!checkPermission(data.pog, 'CASINO_MANAGE')) throw new TakaroUserError('You do not have permission to use admin casino commands.');

  const { days: daysArg } = data.arguments;
  const days = daysArg ?? 7;

  let allStats = [];
  let page = 0;
  const pageSize = 100;
  while (true) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { gameServerId: [gameServerId] },
      search: { key: ['casino_stats:'] },
      limit: pageSize,
      page,
    });
    const batch = res.data.data.filter(v => v.key.startsWith('casino_stats:'));
    for (const v of batch) {
      try {
        const s = JSON.parse(v.value);
        const pId = v.key.replace('casino_stats:', '');
        allStats.push({ playerId: pId, ...s });
      } catch {}
    }
    if (res.data.data.length < pageSize) break;
    page++;
  }

  if (!allStats.length) {
    await pm('No casino stats available for report.');
    return;
  }

  let totalWagered = 0;
  let totalPaidOut = 0;
  const perGame = {};

  for (const s of allStats) {
    totalWagered += s.wagered || 0;
    totalPaidOut += s.won || 0;
    if (s.perGame) {
      for (const [game, g] of Object.entries(s.perGame)) {
        if (!perGame[game]) perGame[game] = { wagered: 0, won: 0, plays: 0 };
        perGame[game].wagered += g.wagered || 0;
        perGame[game].won += g.won || 0;
        perGame[game].plays += g.plays || 0;
      }
    }
  }

  const houseProfit = totalWagered - totalPaidOut;

  const top5 = allStats
    .sort((a, b) => (b.wagered || 0) - (a.wagered || 0))
    .slice(0, 5);

  const top5Lines = [];
  for (const s of top5) {
    let name = s.playerId;
    try {
      const pRes = await takaro.player.playerControllerGetOne(s.playerId);
      name = pRes.data.data.name || s.playerId;
    } catch {}
    top5Lines.push(`  ${name}: ${s.wagered} wagered | ${s.won} won | net ${s.net >= 0 ? '+' : ''}${s.net}`);
  }

  const lines = [
    `=== Casino Report (all-time; ${allStats.length} players) ===`,
    `Total wagered: ${totalWagered}`,
    `Total paid out: ${totalPaidOut}`,
    `House profit: ${houseProfit}`,
    '',
    'Top 5 players by wagered:',
    ...top5Lines,
    '',
    'Per-game breakdown:',
    ...Object.entries(perGame).map(([g, d]) =>
      `  ${g}: ${d.plays} plays | ${d.wagered} wagered | ${d.won} paid out | profit: ${d.wagered - d.won}`
    ),
  ];

  await pm(lines.join('\n'));
}
await main();
