import { takaro, data, TakaroUserError } from '@takaro/helpers';

async function main() {
  const { user, pog, arguments: args, gameServerId } = data;

  if (!user) {
    throw new TakaroUserError('You must link your account to Takaro to use this command.');
  }

  const filters = {
    userId: [user.id],
    status: ['PAID'],
  };

  if (gameServerId) {
    filters.gameServerId = [gameServerId];
  }

  const pendingOrdersRes = await takaro.shopOrder.shopOrderControllerSearch({
    filters,
    sortBy: 'createdAt',
    sortDirection: 'asc',
  });

  if (pendingOrdersRes.data.data.length === 0) {
    console.log('You have no pending orders.');
    await pog.pm('You have no pending orders.');
    return;
  }

  let ordersToClaim = [];
  if (args.all) {
    ordersToClaim = pendingOrdersRes.data.data;
  } else {
    ordersToClaim.push(pendingOrdersRes.data.data[0]);
  }

  let claimed = 0;
  let failed = 0;

  for (const order of ordersToClaim) {
    try {
      await takaro.shopOrder.shopOrderControllerClaim(order.id);
      claimed++;
    } catch (err) {
      console.error(`Failed to claim order ${order.id}: ${err}`);
      failed++;
    }
  }

  console.log(`claim: successfully claimed ${claimed} order(s)`);

  if (claimed === 0) {
    throw new TakaroUserError(`Failed to claim ${failed} order(s). Please try again later.`);
  }

  if (failed > 0) {
    await pog.pm(`Claimed ${claimed} of ${ordersToClaim.length} orders. ${failed} failed.`);
  } else {
    await pog.pm(`Successfully claimed ${claimed} order(s).`);
  }
}

await main();
