import { data, takaro } from '@takaro/helpers';

async function main() {
  const { arguments: args } = data;
  const name = args.name || 'World';

  console.log(`Greeting: Hello, ${name}!`);

  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
    message: `Hello, ${name}!`,
    opts: {},
  });
}

await main();
