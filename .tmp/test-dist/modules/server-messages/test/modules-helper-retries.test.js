import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installModule, uninstallModule } from '../../../test/helpers/modules.js';
function makeTakaroError(status, message) {
    const error = new Error(message);
    error.response = { status };
    return error;
}
describe('modules helper retry coverage', () => {
    it('retries installModule after a transient 500 and eventually succeeds', async () => {
        let installAttempts = 0;
        let installationExists = false;
        const client = {
            module: {
                moduleVersionControllerGetModuleVersion: async () => ({
                    data: { data: { moduleId: 'module-1' } },
                }),
                moduleInstallationsControllerInstallModule: async () => {
                    installAttempts += 1;
                    if (installAttempts === 1) {
                        throw makeTakaroError(500, 'Internal Server Error');
                    }
                    installationExists = true;
                },
                moduleInstallationsControllerGetModuleInstallation: async () => {
                    if (!installationExists)
                        throw makeTakaroError(404, 'not installed');
                    return { data: { data: { id: 'installation-1' } } };
                },
            },
        };
        await installModule(client, 'version-1', 'gameserver-1');
        assert.equal(installAttempts, 2);
    });
    it('treats already-installed install errors as success once the desired state is observed', async () => {
        let installAttempts = 0;
        const client = {
            module: {
                moduleVersionControllerGetModuleVersion: async () => ({
                    data: { data: { moduleId: 'module-2' } },
                }),
                moduleInstallationsControllerInstallModule: async () => {
                    installAttempts += 1;
                    throw makeTakaroError(409, 'already installed');
                },
                moduleInstallationsControllerGetModuleInstallation: async () => ({
                    data: { data: { id: 'installation-2' } },
                }),
            },
        };
        await installModule(client, 'version-2', 'gameserver-2');
        assert.equal(installAttempts, 1);
    });
    it('retries uninstallModule after a transient connection reset and eventually succeeds', async () => {
        let uninstallAttempts = 0;
        let installationExists = true;
        const client = {
            module: {
                moduleInstallationsControllerUninstallModule: async () => {
                    uninstallAttempts += 1;
                    if (uninstallAttempts === 1) {
                        throw new Error('ECONNRESET while uninstalling');
                    }
                    installationExists = false;
                },
                moduleInstallationsControllerGetModuleInstallation: async () => {
                    if (!installationExists)
                        throw makeTakaroError(404, 'not installed');
                    return { data: { data: { id: 'installation-3' } } };
                },
            },
        };
        await uninstallModule(client, 'module-3', 'gameserver-3');
        assert.equal(uninstallAttempts, 2);
    });
    it('treats not-installed uninstall errors as success once absence is confirmed', async () => {
        let uninstallAttempts = 0;
        const client = {
            module: {
                moduleInstallationsControllerUninstallModule: async () => {
                    uninstallAttempts += 1;
                    throw makeTakaroError(404, 'not installed');
                },
                moduleInstallationsControllerGetModuleInstallation: async () => {
                    throw makeTakaroError(404, 'not installed');
                },
            },
        };
        await uninstallModule(client, 'module-4', 'gameserver-4');
        assert.equal(uninstallAttempts, 1);
    });
});
