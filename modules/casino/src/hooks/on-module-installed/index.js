import { data, takaro } from '@takaro/helpers';
import { assertNoLegacyCasinoModules } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;

  try {
    await assertNoLegacyCasinoModules(gameServerId, mod.moduleId);
  } catch (err) {
    const message = String(err?.message ?? err ?? 'Legacy casino module conflict detected.');
    console.log(`casino.onModuleInstalled: legacy casino module conflict detected; gameplay is disabled until the old modules are removed: ${message}`);
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `🎰 Casino installed in conflict mode: gameplay is disabled until the old gambling modules are removed. ${message}`,
        opts: {},
      });
    } catch (notifyErr) {
      console.error(`casino.onModuleInstalled: failed to notify server chat: ${notifyErr}`);
    }
  }
}

await main();
