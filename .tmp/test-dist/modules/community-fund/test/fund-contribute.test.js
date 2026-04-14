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
// NOTE: Tests in this suite run sequentially and share fund state within the suite.
// player[0] has COMMUNITY_FUND_CONTRIBUTE permission; player[1] does NOT.
// The threshold is 100 and tests are ordered so they don't interfere with each other:
// 1. contribute 20 (fund=20, player0 has consumed 20)
// 2. deny contribution when player lacks permission (player1, fund still 20)
// 3. reject below minimum (player0, fund still 20)
// 4. reject insufficient currency (player0, fund still 20)
// 5. reject invalid amount 0 (player0, fund still 20)
// 6. completion test: player0 contributes 100 (fund resets, cycle=1)
describe('community-fund: fund-contribute command', () => {
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
                fundThreshold: 100,
                minimumContribution: 10,
                completionMessage: 'The community fund reached {threshold}!',
                completionCommands: [],
                broadcastContributions: true,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        // Assign COMMUNITY_FUND_CONTRIBUTE permission to player[0] only
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
    it('should contribute currency to the fund and PM the player', async () => {
        const player = ctx.players[0];
        // Give the player some currency first
        await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, { currency: 500 });
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 20`,
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
        assert.equal(meta?.result?.success, true, 'Expected command to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('Fund contribution')), `Expected log to contain "Fund contribution", got: ${JSON.stringify(logMessages)}`);
        // Verify actual fund total via /fundstatus after contribution
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
        assert.ok(statusEvent, 'Expected a fundstatus event after contribution');
        const statusMeta = statusEvent.meta;
        assert.equal(statusMeta?.result?.success, true, 'Expected fundstatus to succeed');
        const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
        // After contributing 20, fund should show total=20 and threshold=100
        assert.ok(statusLogs.some((msg) => msg.includes('total=20') && msg.includes('threshold=100')), `Expected fundstatus log to show total=20 and threshold=100, got: ${JSON.stringify(statusLogs)}`);
    });
    it('should deny contribution when player lacks permission', async () => {
        // player[1] has no COMMUNITY_FUND_CONTRIBUTE permission
        const player = ctx.players[1];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 20`,
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
    it('should reject contribution below minimumContribution', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 5`,
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
        // A TakaroUserError causes success:false
        assert.equal(meta?.result?.success, false, 'Expected command to fail with minimum contribution error');
    });
    it('should reject contribution when player has insufficient currency', async () => {
        const player = ctx.players[0];
        // Player0 started with 500, contributed 20, so has ~480 left
        // Contribute a huge amount the player definitely doesn't have
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 99999`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail with insufficient currency error');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('enough currency')), `Expected log to mention "enough currency", got: ${JSON.stringify(logMessages)}`);
    });
    it('should reject contribution of 0', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 0`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail for amount=0');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('positive whole number')), `Expected log to mention "positive whole number", got: ${JSON.stringify(logMessages)}`);
    });
    it('should trigger completion when fund reaches threshold', async () => {
        // Use player[0] who has COMMUNITY_FUND_CONTRIBUTE permission
        const player = ctx.players[0];
        // Player[0] started with 500, contributed 20 in the first test, so has ~480 left
        // Fund is currently at 20 from the first test
        // Contributing 100 will push it to 120 >= 100 threshold, triggering completion
        // Carryover: (20+100) - 100 = 20
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}fund 100`,
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
        assert.equal(meta?.result?.success, true, 'Expected completion to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('Fund contribution')), `Expected a fund contribution log, got: ${JSON.stringify(logMessages)}`);
        // After completion, verify fund was reset (to carryover) and cycle incremented via /fundstatus
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
        assert.ok(statusEvent, 'Expected a fundstatus event after completion');
        const statusMeta = statusEvent.meta;
        assert.equal(statusMeta?.result?.success, true, 'Expected fundstatus to succeed after completion');
        const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
        // After completion, cycle should be 1
        assert.ok(statusLogs.some((msg) => msg.includes('cycle=1')), `Expected fundstatus to show cycle=1 after completion, got: ${JSON.stringify(statusLogs)}`);
        // Fund should be at carryover value: (20+100)-100 = 20
        assert.ok(statusLogs.some((msg) => msg.includes('total=20')), `Expected fundstatus to show total=20 (carryover), got: ${JSON.stringify(statusLogs)}`);
    });
});
