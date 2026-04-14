import { data, takaro } from '@takaro/helpers';

async function main() {
  const { player } = data;

  console.log(`Player connected: ${player.name}`);

  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
    message: `Welcome to the server, ${player.name}!`,
    opts: {},
  });
}

await main();
