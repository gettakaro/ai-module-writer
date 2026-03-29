import { takaro, data, TakaroUserError } from '@takaro/helpers';

async function main() {
  const { arguments: args, pog, gameServerId } = data;
  let { page, item, action } = args;

  if (!page || page < 1) page = 1;
  page = Math.floor(page);

  const shopItems = await takaro.shopListing.shopListingControllerSearch({
    limit: 5,
    page: page - 1,
    sortBy: 'name',
    sortDirection: 'asc',
    filters: {
      gameServerId: [gameServerId],
      draft: false,
    },
  });

  if (shopItems.data.data.length === 0) {
    console.log('No items found.');
    await pog.pm('No items found.');
    return;
  }

  const currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', gameServerId)).data.data.value;

  if (!item) {
    let index = 1;
    for (const listing of shopItems.data.data) {
      const items = listing.items.slice(0, 3).map((i) => {
        return `${i.amount}x ${i.item.name}`;
      });
      await pog.pm(`${index} - ${listing.name} - ${listing.price} ${currencyName}. ${items.join(', ')}`);
      index++;
    }
    return;
  }

  const selectedItem = shopItems.data.data[item - 1];
  if (!selectedItem) {
    throw new TakaroUserError(
      `Item not found. Please select an item from the list, valid options are 1-${shopItems.data.data.length}.`,
    );
  }

  if (action === 'none') {
    await pog.pm(`Listing ${selectedItem.name} - ${selectedItem.price} ${currencyName}`);
    await Promise.all(
      selectedItem.items.map((i) => {
        const quality = i.quality ? `Quality: ${i.quality}` : '';
        const description = (i.item.description ? `Description: ${i.item.description}` : '').replaceAll('\\n', ' ');
        return pog.pm(`- ${i.amount}x ${i.item.name}. ${quality} ${description}`);
      }),
    );
    return;
  }

  if (action === 'buy') {
    // Pre-check is UX-only; server-side order creation also validates balance.
    if (pog.currency < selectedItem.price) {
      throw new TakaroUserError('You cannot afford this item.');
    }

    const orderRes = await takaro.shopOrder.shopOrderControllerCreate({
      amount: 1,
      listingId: selectedItem.id,
      playerId: pog.playerId,
    });

    // Attempt to claim the order; if claim fails, inform the player to use /claim
    try {
      await takaro.shopOrder.shopOrderControllerClaim(orderRes.data.data.id);
      await pog.pm(`You have purchased ${selectedItem.name} for ${selectedItem.price} ${currencyName}.`);
    } catch {
      await pog.pm(
        `Purchase complete but delivery failed — use /claim to retry.`,
      );
    }
    return;
  }

  throw new TakaroUserError('Invalid action. Valid actions are "buy".');
}

await main();
