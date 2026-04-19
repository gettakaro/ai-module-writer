import { data } from '@takaro/helpers';
import { trimOrEmpty } from './utils-helpers.js';

async function main() {
  const { pog, module: mod } = data;
  const discordLink = trimOrEmpty(mod.userConfig.discordLink);

  if (discordLink === '') {
    const message = 'This server has not configured a Discord link.';
    console.log(message);
    await pog.pm(message);
    return;
  }

  const message = `Join our Discord: ${discordLink}`;
  console.log(message);
  await pog.pm(message);
}

await main();
