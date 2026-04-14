import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer } from '../../../test/helpers/mock-server.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import { pushModule, installModule, uninstallModule, deleteModule, getCommandPrefix, cleanupTestModules, cleanupTestGameServers, } from '../../../test/helpers/modules.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
describe('hello-world: greet command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    before(async () => {
        client = await createClient();
        // Clean up any leftover test modules/game servers from previous runs
        await cleanupTestModules(client);
        await cleanupTestGameServers(client);
        ctx = await startMockServer(client);
        const mod = await pushModule(client, MODULE_DIR);
        moduleId = mod.id;
        versionId = mod.latestVersion.id;
        await installModule(client, versionId, ctx.gameServer.id);
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
    });
    after(async () => {
        try {
            await uninstallModule(client, moduleId, ctx.gameServer.id);
        }
        catch (err) {
            console.error('Cleanup: failed to uninstall module:', err);
        }
        try {
            await deleteModule(client, moduleId);
        }
        catch (err) {
            console.error('Cleanup: failed to delete module:', err);
        }
        await stopMockServer(ctx.server, client, ctx.gameServer.id);
    });
    it('should execute greet command without arguments', async () => {
        const player = ctx.players[0];
        const before = new Date();
        // Trigger command via the API's command trigger endpoint (player sends chat message)
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}greet`,
            playerId: player.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        assert.equal(event.eventName, 'command-executed', 'Event name should be command-executed');
        assert.equal(event.gameserverId, ctx.gameServer.id, 'Event should be for the correct game server');
        assert.ok(event.moduleId, 'Event should reference the installed module');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected command to succeed');
        assert.ok(Array.isArray(meta?.result?.logs), 'Expected result.logs to be an array');
        // Verify the greet command produced a "Hello" message (no name argument = fallback greeting)
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('Hello')), `Expected log to contain "Hello", got: ${JSON.stringify(logMessages)}`);
    });
    it('should execute greet command with a name argument', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}greet World`,
            playerId: player.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        assert.equal(event.eventName, 'command-executed', 'Event name should be command-executed');
        assert.equal(event.gameserverId, ctx.gameServer.id, 'Event should be for the correct game server');
        assert.ok(event.moduleId, 'Event should reference the installed module');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected command to succeed');
        assert.ok(Array.isArray(meta?.result?.logs), 'Expected result.logs to be an array');
        // Verify the name argument appeared in the log output
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('World')), `Expected log to contain "World" (the name argument), got: ${JSON.stringify(logMessages)}`);
    });
});
