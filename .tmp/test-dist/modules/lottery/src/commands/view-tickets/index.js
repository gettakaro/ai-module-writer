import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { getPlayerTickets } from './lottery-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;

  if (!checkPermission(pog, 'LOTTERY_VIEW_TICKETS')) {
    throw new TakaroUserError('You do not have permission to view lottery tickets.');
  }

  const moduleId = mod.moduleId;
  const tickets = await getPlayerTickets(gameServerId, moduleId, pog.playerId);

  console.log(`viewtickets: playerId=${pog.playerId}, tickets=${tickets}`);

  if (tickets === 0) {
    await pog.pm('You have no tickets in the current draw. Use the buyticket command to participate!');
  } else {
    await pog.pm(`You have ${tickets} ticket${tickets > 1 ? 's' : ''} in the current draw.`);
  }
}

await main();
