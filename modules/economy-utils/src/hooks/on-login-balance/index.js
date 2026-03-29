import { takaro, data } from '@takaro/helpers';

async function main() {
  const { gameServerId, player, pog, module: mod } = data;

  if (!mod.userConfig.showBalanceOnLogin) {
    return;
  }

  const currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', gameServerId)).data.data.value;

  console.log(`on-login-balance: player has ${pog.currency} ${currencyName}`);
  await pog.pm(`Your balance: ${pog.currency} ${currencyName}`);
}

await main();
