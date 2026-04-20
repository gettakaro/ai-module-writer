import { data } from '@takaro/helpers';
import { safePrivateMessage, trimOrEmpty } from './utils-helpers.js';

async function main() {
  const { pog, module: mod } = data;
  const discordLink = trimOrEmpty(mod.userConfig.discordLink);

  if (discordLink === '') {
    const message = 'This server has not configured a Discord link.';
    await safePrivateMessage(pog, message);
    return;
  }

  const message = `Join our Discord: ${discordLink}`;
  await safePrivateMessage(pog, message);
}

await main();
