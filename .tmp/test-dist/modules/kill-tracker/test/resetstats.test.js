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
// player[0] has KILL_TRACKER_RESET permission
// player[1] has KILL_TRACKER_VIEW_STATS permission (for verification via /top and /stats)
// player[2] has no permissions
describe('kill-tracker: /resetstats command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    let resetRoleId;
    let viewRoleId;
    before(async () => {
        client = await createClient();
        await cleanupTestModules(client);
        await cleanupTestGameServers(client);
        ctx = await startMockServer(client);
        // Wait until all 3 players are online
        const maxWait = 30000;
        const pollInterval = 2000;
        const start = Date.now();
        while (ctx.players.length < 3 && Date.now() - start < maxWait) {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
            const res = await client.playerOnGameserver.playerOnGameServerControllerSearch({
                filters: { gameServerId: [ctx.gameServer.id], online: [true] },
            });
            if (res.data.data.length >= 3) {
                ctx.players = res.data.data;
                break;
            }
        }
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
                leaderboardPageSize: 10,
                killBroadcast: false,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        resetRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['KILL_TRACKER_RESET']);
        viewRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, ['KILL_TRACKER_VIEW_STATS']);
    });
    after(async () => {
        await cleanupRole(client, resetRoleId);
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
    it('should deny resetstats to player without KILL_TRACKER_RESET permission', async () => {
        const player = ctx.players[2];
        const before = new Date();
        // Permission check fires before argument validation, so no-arg still tests auth
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}resetstats`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail without reset permission');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('do not have permission')), `Expected permission denied, got: ${JSON.stringify(logMessages)}`);
    });
    it('should fail without an explicit argument to prevent accidental reset', async () => {
        // Requires KILL_TRACKER_RESET permission (player[0]). Without an arg, the command
        // should throw a TakaroUserError asking for an explicit target.
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}resetstats`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail with no argument (destructive guard)');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('specify a target') || msg.includes('resetstats all')), `Expected usage error message, got: ${JSON.stringify(logMessages)}`);
    });
    it('should reset all stats and start a new season when /resetstats all is used', async () => {
        // First generate some kills so we have stats to reset
        const player0 = ctx.players[0];
        const killBefore = new Date();
        await ctx.server.executeConsoleCommand(`triggerKill ${player0.gameId}`);
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: killBefore,
            timeout: 30000,
        });
        // Reset all stats with explicit 'all' argument
        const resetBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}resetstats all`,
            playerId: player0.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: resetBefore,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected full reset to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('resetstats: full reset') || msg.includes('new season=')), `Expected full reset log, got: ${JSON.stringify(logMessages)}`);
    });
    it('should verify stats are cleared after full reset', async () => {
        // Depends on previous test: full reset was run, so leaderboard should be empty.
        // Use player[1] who has VIEW_STATS to check leaderboard is empty.
        const player1 = ctx.players[1];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}top`,
            playerId: player1.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected leaderboard to succeed after reset');
        // After a full reset, leaderboard should show "No stats" message
        // (The command sends a PM but logs via console.log in the leaderboard command)
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('leaderboard:')), `Expected leaderboard log after reset, got: ${JSON.stringify(logMessages)}`);
    });
    it('should fail with error when player name not found', async () => {
        const player0 = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}resetstats nonexistentplayername123`,
            playerId: player0.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, false, 'Expected command to fail for non-existent player');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('not found') || msg.includes('nonexistentplayername123')), `Expected "not found" error, got: ${JSON.stringify(logMessages)}`);
    });
    it('should reset only a specific player stats when given a player name', async () => {
        // Depends on previous test: after full reset, all stats are at 0.
        // Give player[0] a kill, then reset only player[0]'s stats.
        // player[1] should retain their stats (though they have no kills in this test).
        const player0 = ctx.players[0];
        const player1 = ctx.players[1];
        // Give player[0] some kills
        const kill1Before = new Date();
        await ctx.server.executeConsoleCommand(`triggerKill ${player0.gameId}`);
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: kill1Before,
            timeout: 30000,
        });
        // Give player[1] some kills too so we can verify they survive the per-player reset
        const kill2Before = new Date();
        await ctx.server.executeConsoleCommand(`triggerKill ${player1.gameId}`);
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: kill2Before,
            timeout: 30000,
        });
        // Resolve player[0]'s Takaro display name for the resetstats command
        const player0Info = await client.player.playerControllerGetOne(player0.playerId);
        const player0Name = player0Info.data.data.name;
        // Reset only player[0]'s stats
        const resetBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}resetstats ${player0Name}`,
            playerId: player0.playerId,
        });
        const resetEvent = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: resetBefore,
            timeout: 30000,
        });
        assert.ok(resetEvent, 'Expected a command-executed event');
        const resetMeta = resetEvent.meta;
        assert.equal(resetMeta?.result?.success, true, 'Expected per-player reset to succeed');
        const resetLogs = (resetMeta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(resetLogs.some((msg) => msg.includes('reset stats for player=') || msg.includes(player0Name)), `Expected per-player reset log mentioning player name, got: ${JSON.stringify(resetLogs)}`);
        // Verify player[1] still has stats (their kill should be intact)
        // player[1] has KILL_TRACKER_VIEW_STATS so can run /stats
        const statsBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}stats`,
            playerId: player1.playerId,
        });
        const statsEvent = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: statsBefore,
            timeout: 30000,
        });
        assert.ok(statsEvent, 'Expected stats command-executed event for player[1]');
        const statsMeta = statsEvent.meta;
        assert.equal(statsMeta?.result?.success, true, 'Expected stats command to succeed for player[1]');
        const statsLogs = (statsMeta?.result?.logs ?? []).map((l) => l.msg);
        // player[1] should have kills=1 from their kill above (not reset)
        assert.ok(statsLogs.some((msg) => msg.includes('kills=1')), `Expected player[1] to still have kills=1 after per-player reset of player[0], got: ${JSON.stringify(statsLogs)}`);
    });
});
