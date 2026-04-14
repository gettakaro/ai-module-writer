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
// Tests trigger entity-killed events using the mock server console command:
//   triggerKill <playerGameId>
// This fires an entity-killed event for the specified player (mob kill — no player victim).
//
// NOTE: The on-death hook (player-death → death penalty + PvP attribution) is NOT tested
// here because the mock server does not implement a triggerDeath console command. The
// mock server's executeConsoleCommand only supports: version, connectAll, disconnectAll,
// scenario, say, ban, unban, triggerKill, setPlayerPing.
// Death hook behaviour is verified manually via in-game testing with real bots.
// See: test/helpers/mock-server.ts and @takaro/mock-gameserver source for available commands.
describe('kill-tracker: on-kill hook (mob kill tracking)', () => {
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
                streakBonusInterval: 3,
                streakBonusPoints: 15,
                streakBroadcast: false,
                streakResetOnDeath: true,
                awardCurrency: false,
                leaderboardPageSize: 10,
                killBroadcast: false,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        // Grant player[0] KILL_TRACKER_VIEW_STATS so we can verify state with /stats
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
    it('should track a mob kill and award points', async () => {
        const player = ctx.players[0];
        const before = new Date();
        // triggerKill <gameId> fires entity-killed event for that player (no player victim = mob kill)
        await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a hook-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected hook to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('on-kill: mob kill')), `Expected log to contain "on-kill: mob kill", got: ${JSON.stringify(logMessages)}`);
        assert.ok(logMessages.some((msg) => msg.includes('mobKills=1')), `Expected log to show mobKills=1, got: ${JSON.stringify(logMessages)}`);
        // mobKillPoints=5 in config, verify specific point value
        assert.ok(logMessages.some((msg) => msg.includes('pointsEarned=5')), `Expected log to show pointsEarned=5 (mobKillPoints=5 * multiplier=1), got: ${JSON.stringify(logMessages)}`);
        // Verify persisted state with /stats command
        const statsBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}stats`,
            playerId: player.playerId,
        });
        const statsEvent = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: statsBefore,
            timeout: 30000,
        });
        assert.ok(statsEvent, 'Expected stats command-executed event');
        const statsMeta = statsEvent.meta;
        assert.equal(statsMeta?.result?.success, true, 'Expected stats command to succeed');
        const statsLogs = (statsMeta?.result?.logs ?? []).map((l) => l.msg);
        // Verify kills=1 and points=5 are persisted
        assert.ok(statsLogs.some((msg) => msg.includes('kills=1') && msg.includes('points=5')), `Expected stats to show kills=1 and points=5, got: ${JSON.stringify(statsLogs)}`);
    });
    it('should track streak and award bonus at milestone', async () => {
        // Depends on previous test: player[0] already has 1 mob kill (streak=1).
        // The streak bonus fires every 3 kills (streakBonusInterval=3).
        // So 2 more kills bring streak to 3, triggering the bonus.
        const player = ctx.players[0];
        // Trigger kill #2 (streak=2)
        const before2 = new Date();
        await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: before2,
            timeout: 30000,
        });
        // Trigger kill #3 (streak=3 → milestone fires bonus=15)
        const before3 = new Date();
        await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);
        const milestoneEvent = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: before3,
            timeout: 30000,
        });
        assert.ok(milestoneEvent, 'Expected a hook-executed event for streak milestone');
        const meta = milestoneEvent.meta;
        assert.equal(meta?.result?.success, true, 'Expected hook to succeed on streak milestone');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('on-kill: mob kill')), `Expected mob kill log, got: ${JSON.stringify(logMessages)}`);
        // At streak=3 (milestone interval=3), bonus=15 should be awarded
        assert.ok(logMessages.some((msg) => msg.includes('bonus=15') && msg.includes('streak=3')), `Expected streak bonus log with bonus=15 and streak=3, got: ${JSON.stringify(logMessages)}`);
    });
    it('should apply KILL_TRACKER_MULTIPLIER (count=2) to double points', async () => {
        // Depends on previous tests: player[1] has no kills yet. Grant them a 2x multiplier.
        const player = ctx.players[1];
        const multiplierRoleId = await assignPermissions(client, player.playerId, ctx.gameServer.id, [{ code: 'KILL_TRACKER_MULTIPLIER', count: 2 }]);
        try {
            const before = new Date();
            await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);
            const event = await waitForEvent(client, {
                eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
                gameserverId: ctx.gameServer.id,
                after: before,
                timeout: 30000,
            });
            assert.ok(event, 'Expected a hook-executed event with multiplier');
            const meta = event.meta;
            assert.equal(meta?.result?.success, true, 'Expected hook to succeed with multiplier');
            const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
            // mobKillPoints=5, multiplier=2 → pointsEarned=10
            assert.ok(logMessages.some((msg) => msg.includes('pointsEarned=10')), `Expected pointsEarned=10 (5 * 2x multiplier), got: ${JSON.stringify(logMessages)}`);
        }
        finally {
            await cleanupRole(client, multiplierRoleId);
        }
    });
    it('should execute hook for additional player (third player mob kill)', async () => {
        // Verify the hook fires correctly for a third player with no prior kills.
        // awardCurrency is false in this test suite; currency awarding is verified in-game.
        const player = ctx.players[2];
        const before = new Date();
        await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
            gameserverId: ctx.gameServer.id,
            after: before,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a hook-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected hook to succeed');
    });
});
