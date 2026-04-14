import { data } from '@takaro/helpers';

async function main() {
  const { pog } = data;

  const now = new Date();
  const nextMidnightUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));

  const msUntilDraw = nextMidnightUtc.getTime() - now.getTime();
  const totalMinutes = Math.floor(msUntilDraw / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  console.log(`nextdraw: hours=${hours}, minutes=${minutes}`);

  await pog.pm(`Next lottery draw in ${hours} hour${hours !== 1 ? 's' : ''} and ${minutes} minute${minutes !== 1 ? 's' : ''}.`);
}

await main();
