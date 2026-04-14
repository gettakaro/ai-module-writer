import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer } from '../../../test/helpers/mock-server.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import { pushModule, installModule, uninstallModule, deleteModule, getCommandPrefix, cleanupTestModules, cleanupTestGameServers, assignPermissions, cleanupRole, } from '../../../test/helpers/modules.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
// /fundstatus is intentionally public — no permission required.
// However, the "after contribution" test needs player[0] to have COMMUNITY_FUND_CONTRIBUTE
// so the /fund command succeeds before we check /fundstatus.
describe('community-fund: fund-status command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    let contributeRoleId;
    before(async () => {
        client = await createClient();
        await cleanupTestModules(client);
        await cleanupTestGameServers(client);
        ctx = await startMockServer(client);
        // Enable economy for this game server so currency operations work
        await client.settings.settingsControllerSet('economyEnabled', {
            gameServerId: ctx.gameServer.id,
            value: 'true',
        });
        const mod = await pushModule(client, MODULE_DIR);
        moduleId = mod.id;
        versionId = mod.latestVersion.id;
        await installModule(client, versionId, ctx.gameServer.id, {
            userConfig: {
                fundThreshold: 500,
                minimumContribution: 1,
                completionMessage: 'Fund reached {threshold}!',
                completionCommands: [],
                broadcastContributions: false,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        // Assign COMMUNITY_FUND_CONTRIBUTE to player[0] so contribution-based tests can succeed
        contributeRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['COMMUNITY_FUND_CONTRIBUTE']);
    });
    after(async () => {
        await cleanupRole(client, contributeRoleId);
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
    it('should display fund status with zero balance on a fresh fund', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fundstatus`,
            playerId: player.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected fundstatus to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('Fund status')), `Expected log to contain "Fund status", got: ${JSON.stringify(logMessages)}`);
        // Verify actual values — fresh fund should show 0/500 and 0%
        assert.ok(logMessages.some((msg) => msg.includes('total=0') && msg.includes('threshold=500')), `Expected log to show total=0 and threshold=500, got: ${JSON.stringify(logMessages)}`);
    });
    it('should reflect updated balance after a contribution', async () => {
        const player = ctx.players[0];
        // Give currency and contribute
        await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, { currency: 1000 });
        const contributeBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 50`,
            playerId: player.playerId,
        });
        // Wait for contribution to complete
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: contributeBefore,
            timeout: 30000,
        });
        // Now check status
        const statusBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fundstatus`,
            playerId: player.playerId,
        });
        const statusEvent = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: statusBefore,
            timeout: 30000,
        });
        assert.ok(statusEvent, 'Expected a fundstatus event');
        const meta = statusEvent.meta;
        assert.equal(meta?.result?.success, true, 'Expected fundstatus to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        // Should show exact updated total (50) and threshold (500) in the log
        assert.ok(logMessages.some((msg) => msg.includes('total=50') && msg.includes('threshold=500')), `Expected log to show total=50 and threshold=500, got: ${JSON.stringify(logMessages)}`);
    });
});
