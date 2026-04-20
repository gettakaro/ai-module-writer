import { data, takaro } from '@takaro/helpers';
import { assertNoLegacyCasinoModules } from './casino-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;

  try {
    await assertNoLegacyCasinoModules(gameServerId, mod.moduleId);
  } catch (err) {
    const message = String(err?.message ?? err ?? 'Legacy casino module conflict detected.');
    console.log(`casino.onModuleInstalled: install blocked by legacy casino module conflict: ${message}`);
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `🎰 Casino install blocked: uninstall the old gambling modules first. ${message}`,
        opts: {},
      });
    } catch (notifyErr) {
      console.error(`casino.onModuleInstalled: failed to notify server chat: ${notifyErr}`);
    }

    try {
      await takaro.module.moduleInstallationsControllerUninstallModule(mod.moduleId, gameServerId);
      console.log(`casino.onModuleInstalled: uninstalled casino from ${gameServerId} because legacy gambling modules are still installed`);
    } catch (uninstallErr) {
      console.error(`casino.onModuleInstalled: failed to uninstall conflicting casino installation: ${uninstallErr}`);
      throw uninstallErr;
    }
  }
}

await main();
