import { takaro, data } from '@takaro/helpers';

async function main() {
  const { pog, gameServerId } = data;
  const currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', gameServerId)).data.data.value;
  console.log(`balance: ${pog.currency} ${currencyName}`);
  await pog.pm(`balance: ${pog.currency} ${currencyName}`);
}

await main();
