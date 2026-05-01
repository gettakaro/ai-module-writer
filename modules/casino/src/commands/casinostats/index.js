import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const cfg = data.module.userConfig;
  const capWindow = cfg.capWindow ?? 'daily';
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;
  const requesterId = data.player.id;

  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }

  function getCurrentWindowKey() {
    const now = new Date();
    if (capWindow === 'weekly') {
      const jan1 = new Date(now.getFullYear(), 0, 1);
      const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    return now.toISOString().slice(0, 10);
  }

  let targetPlayerId = requesterId;
  let targetPlayerName = data.player.name;

  const { player: playerArg } = data.arguments;
  if (playerArg && playerArg !== 'self') {
    if (!checkPermission(data.pog, 'CASINO_MANAGE')) throw new TakaroUserError('Only admins can view other players\' stats.');
    const playersRes = await takaro.player.playerControllerSearch({ filters: { name: [playerArg] }, limit: 1 });
    if (!playersRes.data.data.length) throw new TakaroUserError(`Player "${playerArg}" not found.`);
    targetPlayerId = playersRes.data.data[0].id;
    targetPlayerName = playersRes.data.data[0].name;
  }

  const statsRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_stats:${targetPlayerId}`], gameServerId: [gameServerId], playerId: [targetPlayerId] }, limit: 1 });
  const stats = statsRes.data.data[0] ? JSON.parse(statsRes.data.data[0].value) : null;

  const windowKey = getCurrentWindowKey();
  const windowRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${targetPlayerId}:${windowKey}`], gameServerId: [gameServerId], playerId: [targetPlayerId] }, limit: 1 });
  const window = windowRes.data.data[0] ? JSON.parse(windowRes.data.data[0].value) : { wagered: 0, lost: 0 };

  if (!stats) {
    await pm(`${targetPlayerName} has no casino stats yet.`);
    return;
  }

  const winrate = stats.gamesPlayed > 0 ? ((stats.won / stats.wagered) * 100).toFixed(1) : '0.0';
  const lines = [
    `=== Casino Stats: ${targetPlayerName} ===`,
    `Lifetime: Wagered ${stats.wagered} | Won ${stats.won} | Net ${stats.net >= 0 ? '+' : ''}${stats.net} | Games: ${stats.gamesPlayed}`,
    `Win Rate: ${winrate}% | Biggest Win: ${stats.biggestWin?.amount ?? 0} (${stats.biggestWin?.game ?? 'n/a'})`,
    `This ${capWindow}: Wagered ${window.wagered} | Lost ${window.lost}`,
  ];

  if (stats.perGame && Object.keys(stats.perGame).length > 0) {
    lines.push('Per Game:');
    for (const [game, g] of Object.entries(stats.perGame)) {
      lines.push(`  ${game}: ${g.plays} plays | Wagered ${g.wagered} | Won ${g.won}`);
    }
  }

  await pm(lines.join('\n'));
}
await main();
