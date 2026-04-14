import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pushModule } from '../../../test/helpers/modules.js';
const tempDirs = [];
function createTempModuleDir(moduleName = 'sample-module') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takaro-module-push-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src', 'cronjobs', 'ping'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({
        name: moduleName,
        description: 'Temp module for push helper tests',
        version: 'latest',
        supportedGames: ['all'],
        cronJobs: {
            ping: {
                temporalValue: '* * * * *',
                description: 'noop',
                function: 'src/cronjobs/ping/index.js',
            },
        },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'src', 'cronjobs', 'ping', 'index.js'), 'export async function main() {}\nawait main();\n');
    return dir;
}
afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
describe('modules helper push coverage', () => {
    it('does not delete the existing module until validation import succeeds', async () => {
        const moduleDir = createTempModuleDir('sample-module');
        const removedIds = [];
        const importedNames = [];
        const validationError = new Error('validation import failed');
        validationError.response = { status: 400 };
        const client = {
            module: {
                moduleControllerSearch: async ({ filters }) => ({
                    data: {
                        data: filters.name[0] === 'test-sample-module' ? [{ id: 'existing-module', name: 'test-sample-module' }] : [],
                    },
                }),
                moduleControllerImport: async (payload) => {
                    importedNames.push(payload.name);
                    throw validationError;
                },
                moduleControllerRemove: async (id) => {
                    removedIds.push(id);
                },
            },
        };
        await assert.rejects(pushModule(client, moduleDir), /validation import failed/);
        assert.equal(importedNames.length, 1);
        assert.match(importedNames[0], /^test-sample-module-validate-/);
        assert.deepEqual(removedIds, []);
    });
    it('surfaces the resolved module name when the final import cannot be found', async () => {
        const moduleDir = createTempModuleDir('sample-module');
        const removedIds = [];
        const importedNames = [];
        const client = {
            module: {
                moduleControllerSearch: async ({ filters }) => {
                    const name = filters.name[0];
                    if (name === 'test-sample-module') {
                        return { data: { data: [] } };
                    }
                    return { data: { data: [{ id: 'validation-module', name }] } };
                },
                moduleControllerImport: async (payload) => {
                    importedNames.push(payload.name);
                },
                moduleControllerRemove: async (id) => {
                    removedIds.push(id);
                },
            },
        };
        await assert.rejects(pushModule(client, moduleDir), /Module 'test-sample-module' not found after import/);
        assert.equal(importedNames.length, 2);
        assert.match(importedNames[0], /^test-sample-module-validate-/);
        assert.equal(importedNames[1], 'test-sample-module');
        assert.deepEqual(removedIds, ['validation-module']);
    });
});
