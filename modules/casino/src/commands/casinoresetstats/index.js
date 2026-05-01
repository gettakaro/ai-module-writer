import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;

  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }

  if (!checkPermission(data.pog, 'CASINO_MANAGE')) throw new TakaroUserError('You do not have permission to use admin casino commands.');

  const { player: playerArg } = data.arguments;
  const playersRes = await takaro.player.playerControllerSearch({ filters: { name: [playerArg] }, limit: 1 });
  if (!playersRes.data.data.length) throw new TakaroUserError(`Player "${playerArg}" not found.`);
  const target = playersRes.data.data[0];

  const statsKey = `casino_stats:${target.id}`;
  const existing = await takaro.variable.variableControllerSearch({ filters: { key: [statsKey], gameServerId: [gameServerId], playerId: [target.id] }, limit: 1 });

  if (!existing.data.data.length) {
    await pm(`${target.name} has no casino stats to reset.`);
    return;
  }

  await takaro.variable.variableControllerDelete(existing.data.data[0].id);
  await pm(`Casino stats reset for ${target.name}.`);
}
await main();
