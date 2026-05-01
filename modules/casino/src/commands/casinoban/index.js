import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;

  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }

  if (!checkPermission(data.pog, 'CASINO_MANAGE')) throw new TakaroUserError('You do not have permission to use admin casino commands.');

  const { player: playerArg, hours } = data.arguments;
  const playersRes = await takaro.player.playerControllerSearch({ filters: { name: [playerArg] }, limit: 1 });
  if (!playersRes.data.data.length) throw new TakaroUserError(`Player "${playerArg}" not found.`);
  const target = playersRes.data.data[0];

  const expiresAt = hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null;
  const banKey = `casino_ban:${target.id}`;

  const existing = await takaro.variable.variableControllerSearch({ filters: { key: [banKey], gameServerId: [gameServerId], playerId: [target.id] }, limit: 1 });
  const banData = JSON.stringify({ expiresAt, bannedBy: data.player.name, bannedAt: new Date().toISOString() });

  if (existing.data.data.length) {
    await takaro.variable.variableControllerUpdate(existing.data.data[0].id, { value: banData });
  } else {
    await takaro.variable.variableControllerCreate({ key: banKey, value: banData, gameServerId, playerId: target.id });
  }

  const durStr = hours ? `for ${hours} hour(s)` : 'permanently';
  await pm(`Casino ban applied: ${target.name} banned ${durStr}.`);
}
await main();
