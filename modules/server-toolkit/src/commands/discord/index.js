import { data } from '@takaro/helpers';
import { trimOrEmpty } from './server-toolkit-pure.js';

async function main() {
  const { pog, module: mod } = data;
  const discordLink = trimOrEmpty(mod.userConfig.discordLink);

  if (discordLink === '') {
    const message = 'This server has not configured a Discord link.';
    console.log(`toolkit:discord unconfigured`);
    console.log(message);
    await pog.pm(message);
    return;
  }

  const message = `Join our Discord: ${discordLink}`;
  console.log(`toolkit:discord ${discordLink}`);
  console.log(message);
  await pog.pm(message);
}

await main();
