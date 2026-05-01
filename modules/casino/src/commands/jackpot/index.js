import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;

  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }

  const jpRes = await takaro.variable.variableControllerSearch({ filters: { key: ['casino_jackpot'], gameServerId: [gameServerId] }, limit: 1 });
  const jp = jpRes.data.data[0] ? JSON.parse(jpRes.data.data[0].value) : { amount: 0, lastWinner: null, lastWinAt: null, lastWinGame: null };

  const lines = [
    `=== Casino Jackpot ===`,
    `Current pool: ${Math.round(jp.amount ?? 0)} coins`,
  ];

  if (jp.lastWinner) {
    const winDate = jp.lastWinAt ? new Date(jp.lastWinAt).toLocaleDateString() : 'unknown';
    lines.push(`Last won by: ${jp.lastWinner} (${jp.lastWinGame}) on ${winDate}`);
  } else {
    lines.push('No jackpot winner yet — play slots to contribute!');
  }

  await pm(lines.join('\n'));
}
await main();
