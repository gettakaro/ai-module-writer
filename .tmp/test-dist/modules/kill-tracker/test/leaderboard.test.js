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
// player[0] has KILL_TRACKER_VIEW_STATS permission
// player[1] does NOT
describe('kill-tracker: /top leaderboard command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    let viewRoleId;
    before(async () => {
        client = await createClient();
        await cleanupTestModules(client);
        await cleanupTestGameServers(client);
        ctx = await startMockServer(client);
        const mod = await pushModule(client, MODULE_DIR);
        moduleId = mod.id;
        versionId = mod.latestVersion.id;
        await installModule(client, versionId, ctx.gameServer.id, {
            userConfig: {
                mobKillPoints: 5,
                pvpKillPoints: 10,
                deathPenalty: 3,
                streakBonusInterval: 10,
                streakBonusPoints: 50,
                streakBroadcast: false,
                streakResetOnDeath: true,
                awardCurrency: false,
                leaderboardPageSize: 5,
                killBroadcast: false,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        viewRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['KILL_TRACKER_VIEW_STATS']);
    });
    after(async () => {
        await cleanupRole(client, viewRoleId);
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
    it('should show empty leaderboard message when no stats recorded', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}top`,
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
        assert.equal(meta?.result?.success, true, 'Expected command to succeed even with empty leaderboard');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('leaderboard:')), `Expected leaderboard log, got: ${JSON.stringify(logMessages)}`);
    });
    it('should show ranked players after kills', async () => {
        const player = ctx.players[0];
        // Trigger 2 mob kills for player[0]
        for (let i = 0; i < 2; i++) {
            const before = new Date();
            await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);
            await waitForEvent(client, {
                eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
                gameserverId: ctx.gameServer.id,
                after: before,
                timeout: 30000,
            });
        }
        // Now check leaderboard
        const topBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}top`,
            playerId: player.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: topBefore,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected leaderboard command to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('players=1') || msg.includes('page=')), `Expected leaderboard page log, got: ${JSON.stringify(logMessages)}`);
        // 2 mob kills at mobKillPoints=5 each = 10 total points; verify points appear in log
        assert.ok(logMessages.some((msg) => msg.includes('pagePoints=10')), `Expected log to mention pagePoints=10, got: ${JSON.stringify(logMessages)}`);
    });
    it('should deny leaderboard to player without KILL_TRACKER_VIEW_STATS permission', async () => {
        const player = ctx.players[1];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}top`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail without permission');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('do not have permission')), `Expected permission denied, got: ${JSON.stringify(logMessages)}`);
    });
    it('should fail with invalid page number', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}top 999`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail for out-of-range page');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('does not exist') || msg.includes('page')), `Expected page error, got: ${JSON.stringify(logMessages)}`);
    });
});
