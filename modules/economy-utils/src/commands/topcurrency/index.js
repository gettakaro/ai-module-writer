import { takaro, data } from '@takaro/helpers';

async function main() {
  const { arguments: args, pog, gameServerId } = data;

  const count = Math.min(Math.max(1, Math.floor(args.count || 10)), 25);

  const richest = (
    await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId] },
      limit: count,
      sortBy: 'currency',
      sortDirection: 'desc',
      extend: ['player'],
    })
  ).data.data;

  if (richest.length === 0) {
    await pog.pm('No players found.');
    return;
  }

  const currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', gameServerId)).data.data.value;

  // Fetch all player names in parallel (order doesn't matter for name lookups)
  const playerNames = await Promise.all(
    richest.map((p) => takaro.player.playerControllerGetOne(p.playerId).then((r) => r.data.data.name)),
  );

  console.log('Richest players:');
  await pog.pm('Richest players:');
  // Send PMs sequentially to preserve leaderboard order
  for (let i = 0; i < richest.length; i++) {
    const line = `${i + 1}. ${playerNames[i]} - ${richest[i].currency} ${currencyName}`;
    console.log(line);
    await pog.pm(line);
  }
}

await main();
