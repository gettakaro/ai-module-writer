import { data } from '@takaro/helpers';
import { getPot, getRollover, getAllTicketEntries } from './lottery-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;

  const moduleId = mod.moduleId;
  const config = mod.userConfig;

  const [pot, rollover, entries] = await Promise.all([
    getPot(gameServerId, moduleId),
    getRollover(gameServerId, moduleId),
    getAllTicketEntries(gameServerId, moduleId),
  ]);

  const participantCount = entries.length;
  const totalTickets = entries.reduce((sum, e) => sum + e.tickets, 0);
  const totalPot = pot + rollover;

  console.log(`lottery-info: pot=${pot}, rollover=${rollover}, participants=${participantCount}, totalTickets=${totalTickets}`);

  if (participantCount === 0) {
    await pog.pm(`Lottery: No participants yet. Ticket price: ${config.ticketPrice}. Use the buyticket command to participate!`);
  } else {
    const estimatedPrize = Math.floor(totalPot * (1 - config.profitMargin));
    // Lead with the prize, then details
    await pog.pm(`Lottery: Estimated prize this draw: ${estimatedPrize} currency.`);
    await pog.pm(`Lottery: Pot: ${totalPot}${rollover > 0 ? ` (incl. ${rollover} rollover)` : ''} | Participants: ${participantCount} | Total tickets: ${totalTickets} | Ticket price: ${config.ticketPrice}.`);
    await pog.pm(`Lottery: The draw runs on a scheduled timer.`);
  }
}

await main();
