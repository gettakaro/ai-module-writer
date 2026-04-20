import { data, TakaroUserError } from '@takaro/helpers';
import { compactRules, safePrivateMessage } from './utils-helpers.js';

async function main() {
  const { pog, module: mod } = data;
  const rules = compactRules(mod.userConfig.rules);

  if (rules.length === 0) {
    const message = 'This server has not configured any rules yet.';
    const delivered = await safePrivateMessage(pog, message);
    if (!delivered) {
      throw new TakaroUserError('I could not deliver the server rules right now. Please try again in a moment.');
    }
    return;
  }

  const lines = ['Server rules:'];
  for (let i = 0; i < rules.length; i++) {
    lines.push(`${i + 1}. ${rules[i]}`);
  }

  const message = lines.join('\n');
  const delivered = await safePrivateMessage(pog, message);
  if (!delivered) {
    throw new TakaroUserError('I could not deliver the server rules right now. Please try again in a moment.');
  }
}

await main();
