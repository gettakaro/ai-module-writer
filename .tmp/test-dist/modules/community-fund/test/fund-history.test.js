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
// player[0] has COMMUNITY_FUND_CONTRIBUTE + COMMUNITY_FUND_VIEW_HISTORY permissions
// player[1] has no custom permissions
describe('community-fund: fund-history command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    let roleId;
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
                fundThreshold: 50,
                minimumContribution: 1,
                completionMessage: 'Fund reached {threshold}!',
                completionCommands: [],
                broadcastContributions: false,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        // Assign both permissions to player[0] in a single role:
        // - COMMUNITY_FUND_VIEW_HISTORY to view history
        // - COMMUNITY_FUND_CONTRIBUTE so history tests can trigger contributions
        roleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['COMMUNITY_FUND_VIEW_HISTORY', 'COMMUNITY_FUND_CONTRIBUTE']);
    });
    after(async () => {
        await cleanupRole(client, roleId);
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
    it('should show "no completions" message on a fresh fund', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fundhistory`,
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
        assert.equal(meta?.result?.success, true, 'Expected fundhistory to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('Fund history')), `Expected log to contain "Fund history", got: ${JSON.stringify(logMessages)}`);
        // Verify that cycleCount=0 is shown on fresh fund
        assert.ok(logMessages.some((msg) => msg.includes('cycleCount=0')), `Expected log to show cycleCount=0 on fresh fund, got: ${JSON.stringify(logMessages)}`);
    });
    it('should deny history view when player lacks permission', async () => {
        // player[1] has no COMMUNITY_FUND_VIEW_HISTORY permission
        const player = ctx.players[1];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fundhistory`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail when player lacks permission');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('do not have permission')), `Expected log to contain "do not have permission", got: ${JSON.stringify(logMessages)}`);
    });
    it('should show completion history after a fund cycle completes', async () => {
        const player = ctx.players[0];
        // Give player currency and trigger a completion (threshold is 50)
        await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, { currency: 5000 });
        const contributeBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 50`,
            playerId: player.playerId,
        });
        // Wait for fund completion
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: contributeBefore,
            timeout: 30000,
        });
        // Now check history
        const historyBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fundhistory`,
            playerId: player.playerId,
        });
        const historyEvent = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: historyBefore,
            timeout: 30000,
        });
        assert.ok(historyEvent, 'Expected a fundhistory event');
        const meta = historyEvent.meta;
        assert.equal(meta?.result?.success, true, 'Expected fundhistory to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('Fund history')), `Expected log to contain "Fund history", got: ${JSON.stringify(logMessages)}`);
        // After a completion, cycleCount should be 1
        assert.ok(logMessages.some((msg) => msg.includes('cycleCount=1')), `Expected log to show cycleCount=1 after completion, got: ${JSON.stringify(logMessages)}`);
    });
});
