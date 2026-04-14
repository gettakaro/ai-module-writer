import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installModule, uninstallModule } from '../../../test/helpers/modules.js';

type FakeClient = {
  module: {
    moduleVersionControllerGetModuleVersion: (versionId: string) => Promise<{ data: { data: { moduleId: string } } }>;
    moduleInstallationsControllerGetModuleInstallation: (
      moduleId: string,
      gameServerId: string,
    ) => Promise<{ data: { data: { moduleId: string; gameServerId: string } } }>;
    moduleInstallationsControllerInstallModule: (payload: Record<string, unknown>) => Promise<void>;
    moduleInstallationsControllerUninstallModule: (moduleId: string, gameServerId: string) => Promise<void>;
  };
};

function notFoundError(message = 'not installed') {
  return {
    message,
    response: {
      status: 404,
    },
  };
}

function serverError(message = 'HTTP 500') {
  return {
    message,
    response: {
      status: 500,
    },
  };
}

describe('module installation helper retries', () => {
  it('treats transient install failures as success once the installation becomes observable', async () => {
    let installed = false;
    let installCalls = 0;
    let getCalls = 0;

    const client: FakeClient = {
      module: {
        async moduleVersionControllerGetModuleVersion() {
          return { data: { data: { moduleId: 'module-1' } } };
        },
        async moduleInstallationsControllerGetModuleInstallation() {
          getCalls += 1;
          if (!installed) throw notFoundError();
          return { data: { data: { moduleId: 'module-1', gameServerId: 'gs-1' } } };
        },
        async moduleInstallationsControllerInstallModule() {
          installCalls += 1;
          installed = true;
          throw serverError('installation request returned 500 after creating the installation');
        },
        async moduleInstallationsControllerUninstallModule() {
          installed = false;
        },
      },
    };

    await installModule(client as never, 'version-1', 'gs-1', {
      userConfig: { enabled: true },
    });

    assert.equal(installCalls, 1);
    assert.ok(getCalls >= 1, 'expected reconciliation polling to verify the installed state');
    assert.equal(installed, true);
  });

  it('retries transient install failures and succeeds on a later attempt', async () => {
    let installed = false;
    let installCalls = 0;

    const client: FakeClient = {
      module: {
        async moduleVersionControllerGetModuleVersion() {
          return { data: { data: { moduleId: 'module-2' } } };
        },
        async moduleInstallationsControllerGetModuleInstallation() {
          if (!installed) throw notFoundError();
          return { data: { data: { moduleId: 'module-2', gameServerId: 'gs-1' } } };
        },
        async moduleInstallationsControllerInstallModule() {
          installCalls += 1;
          if (installCalls < 2) throw serverError('temporary install failure');
          installed = true;
        },
        async moduleInstallationsControllerUninstallModule() {
          installed = false;
        },
      },
    };

    await installModule(client as never, 'version-2', 'gs-1');

    assert.equal(installCalls, 2);
    assert.equal(installed, true);
  });

  it('treats uninstall terminal-state errors as success when the module is already absent', async () => {
    let installed = false;
    let uninstallCalls = 0;
    let getCalls = 0;

    const client: FakeClient = {
      module: {
        async moduleVersionControllerGetModuleVersion() {
          return { data: { data: { moduleId: 'module-3' } } };
        },
        async moduleInstallationsControllerGetModuleInstallation() {
          getCalls += 1;
          if (!installed) throw notFoundError();
          return { data: { data: { moduleId: 'module-3', gameServerId: 'gs-1' } } };
        },
        async moduleInstallationsControllerInstallModule() {
          installed = true;
        },
        async moduleInstallationsControllerUninstallModule() {
          uninstallCalls += 1;
          throw notFoundError('module not installed');
        },
      },
    };

    await uninstallModule(client as never, 'module-3', 'gs-1');

    assert.equal(uninstallCalls, 1);
    assert.ok(getCalls >= 1, 'expected reconciliation polling to confirm the installation is absent');
    assert.equal(installed, false);
  });
});
