import { data } from '@takaro/helpers';
import { compactRules, safePrivateMessage } from './utils-helpers.js';

async function main() {
  const { pog, module: mod } = data;
  const rules = compactRules(mod.userConfig.rules);

  if (rules.length === 0) {
    const message = 'This server has not configured any rules yet.';
    await safePrivateMessage(pog, message);
    return;
  }

  const lines = ['Server rules:'];
  for (let i = 0; i < rules.length; i++) {
    lines.push(`${i + 1}. ${rules[i]}`);
  }

  const message = lines.join('\n');
  await safePrivateMessage(pog, message);
}

await main();
