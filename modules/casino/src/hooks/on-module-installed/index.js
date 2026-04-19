import { data, takaro } from '@takaro/helpers';
import { assertNoLegacyCasinoModules } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;

  try {
    await assertNoLegacyCasinoModules(gameServerId, mod.moduleId);
  } catch (err) {
    const message = String(err?.message ?? err ?? 'Legacy casino module conflict detected.');
    console.log(`casino.onModuleInstalled: install blocked until legacy modules are removed: ${message}`);
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `🎰 Casino install blocked: ${message}`,
        opts: {},
      });
    } catch (notifyErr) {
      console.error(`casino.onModuleInstalled: failed to notify server chat: ${notifyErr}`);
    }
  }
}

await main();
