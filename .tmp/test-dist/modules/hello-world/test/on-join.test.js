import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer } from '../../../test/helpers/mock-server.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import { pushModule, installModule, uninstallModule, deleteModule, cleanupTestModules, cleanupTestGameServers, } from '../../../test/helpers/modules.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
describe('hello-world: on-join hook', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
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
    it('should fire hook-executed when a player connects', async () => {
        // Disconnect a player first, then reconnect them
        await ctx.server.executeConsoleCommand('disconnectAll');
        // Wait for disconnect events to be processed before setting the event timestamp baseline.
        // This prevents the hook-executed event from a previous player-connected (at setup time)
        // being picked up instead of the one triggered by our reconnect.
        // The delay is intentionally conservative; CI environments may be slow.
        // Polling is not feasible here: there's no "all players disconnected" event in the Takaro
        // event API we can wait on — disconnection is a game-server-side state with no async feedback.
        const disconnectSettleMs = Number(process.env['TEST_DISCONNECT_SETTLE_MS'] ?? 2000);
        await new Promise((resolve) => setTimeout(resolve, disconnectSettleMs));
        const before = new Date();
        // Connect all players again — triggers player-connected events
        await ctx.server.executeConsoleCommand('connectAll');
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a hook-executed event');
        assert.equal(event.eventName, 'hook-executed', 'Event name should be hook-executed');
        assert.equal(event.gameserverId, ctx.gameServer.id, 'Event should be for the correct game server');
        assert.ok(event.moduleId, 'Event should reference the installed module');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected hook to succeed');
        assert.ok(Array.isArray(meta?.result?.logs), 'Expected result.logs to be an array');
        // Verify the hook logged the player connection
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('Player connected')), `Expected log to contain "Player connected", got: ${JSON.stringify(logMessages)}`);
    });
});
