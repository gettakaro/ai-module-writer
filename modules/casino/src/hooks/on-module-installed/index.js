import { data, takaro } from '@takaro/helpers';
import { assertNoLegacyCasinoModules } from './casino-helpers.js';

async function uninstallInstalledCasinoCopies(gameServerId) {
  const installed = await takaro.module.moduleInstallationsControllerGetInstalledModules({
    filters: { gameserverId: [gameServerId] },
    limit: 100,
  });

  const casinoRows = (installed.data.data ?? []).filter((row) => String(row.module?.name ?? '').toLowerCase() === 'casino');
  for (const row of casinoRows) {
    try {
      await takaro.module.moduleInstallationsControllerUninstallModule(row.moduleId, gameServerId);
      console.log(`casino.onModuleInstalled: uninstalled casino module ${row.moduleId} because legacy gambling modules are present`);
    } catch (err) {
      if (String(err).includes('404')) {
        console.log(`casino.onModuleInstalled: casino module ${row.moduleId} was already absent during conflict cleanup`);
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const { gameServerId, module: mod } = data;

  try {
    await assertNoLegacyCasinoModules(gameServerId, mod.moduleId);
  } catch (err) {
    const message = String(err?.message ?? err ?? 'Legacy casino module conflict detected.');
    console.log(`casino.onModuleInstalled: ${message}`);
    try {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: `🎰 Casino install blocked: ${message}`,
        opts: {},
      });
    } catch (notifyErr) {
      console.error(`casino.onModuleInstalled: failed to notify server chat: ${notifyErr}`);
    }
    await uninstallInstalledCasinoCopies(gameServerId);
  }
}

await main();
