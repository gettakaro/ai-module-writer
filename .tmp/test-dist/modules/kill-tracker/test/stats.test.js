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
// player[1] does NOT have any permissions
describe('kill-tracker: /stats command', () => {
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
                streakBonusInterval: 5,
                streakBonusPoints: 25,
                streakBroadcast: false,
                streakResetOnDeath: true,
                awardCurrency: false,
                leaderboardPageSize: 10,
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
    it('should show default stats for a new player with no kills', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}stats`,
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
        assert.ok(logMessages.some((msg) => msg.includes('stats: player=')), `Expected stats log, got: ${JSON.stringify(logMessages)}`);
        assert.ok(logMessages.some((msg) => msg.includes('kills=0') && msg.includes('deaths=0')), `Expected zero kills and deaths, got: ${JSON.stringify(logMessages)}`);
    });
    it('should show updated stats after a kill', async () => {
        // Depends on previous test: player[0] may already have stats. This test triggers
        // exactly one more kill and verifies kills increments by checking kills=1.
        // Note: stats.test.ts runs with a fresh module install in each before(), so
        // player[0] starts from 0 kills in this describe block.
        const player = ctx.players[0];
        // Trigger a mob kill
        const killBefore = new Date();
        await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: killBefore,
            timeout: 30000,
        });
        // Now check stats
        const statsBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}stats`,
            playerId: player.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: statsBefore,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected stats command to succeed after kill');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('kills=1')), `Expected kills=1 in stats log, got: ${JSON.stringify(logMessages)}`);
        // mobKillPoints=5 in config — verify exact point value persisted
        assert.ok(logMessages.some((msg) => msg.includes('points=5')), `Expected points=5 (mobKillPoints=5 * 1 kill), got: ${JSON.stringify(logMessages)}`);
    });
    it('should deny stats to player without KILL_TRACKER_VIEW_STATS permission', async () => {
        const player = ctx.players[1];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}stats`,
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
        assert.ok(logMessages.some((msg) => msg.includes('do not have permission')), `Expected permission denied message, got: ${JSON.stringify(logMessages)}`);
    });
});
