import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { pushModule } from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('pushModule helper conflict retry', () => {
  it('retries import when Takaro briefly reports a 409 conflict after delete', async () => {
    const moduleName = 'test-referral-program';
    let searchCalls = 0;
    let importCalls = 0;
    let removedId: string | undefined;

    const client = {
      module: {
        moduleControllerSearch: async () => {
          searchCalls += 1;

          if (searchCalls === 1) {
            return { data: { data: [{ id: 'old-module', name: moduleName }] } };
          }

          if (searchCalls === 2) {
            return { data: { data: [{ id: 'old-module', name: moduleName }] } };
          }

          if (searchCalls === 3 || searchCalls === 4) {
            return { data: { data: [] } };
          }

          return {
            data: {
              data: [{ id: 'new-module', name: moduleName, latestVersion: { id: 'version-1' } }],
            },
          };
        },
        moduleControllerRemove: async (id: string) => {
          removedId = id;
        },
        moduleControllerImport: async () => {
          importCalls += 1;
          if (importCalls === 1) {
            const err = new Error('module import conflict');
            Object.assign(err, {
              response: {
                status: 409,
                data: { message: 'Module already exists' },
              },
            });
            throw err;
          }
        },
      },
    } as never;

    const imported = await pushModule(client, MODULE_DIR);

    assert.equal(removedId, 'old-module');
    assert.equal(importCalls, 2, 'Expected one retry after the synthetic 409 conflict');
    assert.equal(imported.id, 'new-module');
    assert.equal(imported.latestVersion.id, 'version-1');
  });
});
