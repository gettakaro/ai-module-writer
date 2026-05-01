import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;

  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }

  if (!checkPermission(data.pog, 'CASINO_MANAGE')) throw new TakaroUserError('You do not have permission to use admin casino commands.');

  const { amount } = data.arguments;
  if (amount < 0) throw new TakaroUserError('Jackpot amount cannot be negative.');

  const jpRes = await takaro.variable.variableControllerSearch({ filters: { key: ['casino_jackpot'], gameServerId: [gameServerId] }, limit: 1 });
  const jp = jpRes.data.data[0] ? JSON.parse(jpRes.data.data[0].value) : { amount: 0, lastWinner: null, lastWinAt: null, lastWinGame: null };
  jp.amount = amount;

  if (jpRes.data.data[0]) {
    await takaro.variable.variableControllerUpdate(jpRes.data.data[0].id, { value: JSON.stringify(jp) });
  } else {
    await takaro.variable.variableControllerCreate({ key: 'casino_jackpot', value: JSON.stringify(jp), gameServerId });
  }

  await pm(`Jackpot set to ${amount} coins.`);
}
await main();
