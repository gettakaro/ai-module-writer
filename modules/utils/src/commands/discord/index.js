import { data, TakaroUserError } from '@takaro/helpers';
import { safePrivateMessage, trimOrEmpty } from './utils-helpers.js';

async function main() {
  const { pog, module: mod } = data;
  const discordLink = trimOrEmpty(mod.userConfig.discordLink);

  if (discordLink === '') {
    const message = 'This server has not configured a Discord link.';
    const delivered = await safePrivateMessage(pog, message);
    if (!delivered) {
      throw new TakaroUserError('I could not deliver the Discord link message right now. Please try again in a moment.');
    }
    return;
  }

  const message = `Join our Discord: ${discordLink}`;
  const delivered = await safePrivateMessage(pog, message);
  if (!delivered) {
    throw new TakaroUserError('I could not deliver the Discord link message right now. Please try again in a moment.');
  }
}

await main();
