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
describe('daily-rewards: /topstreak command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    before(async () => {
        client = await createClient();
        await cleanupTestModules(client);
        await cleanupTestGameServers(client);
        ctx = await startMockServer(client);
        await client.settings.settingsControllerSet('economyEnabled', {
            gameServerId: ctx.gameServer.id,
            value: 'true',
        });
        const mod = await pushModule(client, MODULE_DIR);
        moduleId = mod.id;
        versionId = mod.latestVersion.id;
        await installModule(client, versionId, ctx.gameServer.id, {
            userConfig: {
                baseReward: 100,
                maxStreak: 365,
                milestoneRewards: [],
                streakGracePeriod: 48,
                notifyOnLogin: false,
                showMultiplierInClaim: false,
            },
        });
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
    it('should show empty leaderboard message when no data exists', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}topstreak`,
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
        assert.equal(meta?.result?.success, true, 'Expected /topstreak to succeed with empty data');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('no daily data recorded yet')), `Expected empty leaderboard log, got: ${JSON.stringify(logMessages)}`);
    });
    it('should show ranked players after claims', async () => {
        const claimRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['DAILY_CLAIM']);
        try {
            const claimBefore = new Date();
            await client.command.commandControllerTrigger(ctx.gameServer.id, {
                msg: `${prefix}daily`,
                playerId: ctx.players[0].playerId,
            });
            await waitForEvent(client, {
                eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
                gameserverId: ctx.gameServer.id,
                after: claimBefore,
                timeout: 30000,
            });
            const topBefore = new Date();
            await client.command.commandControllerTrigger(ctx.gameServer.id, {
                msg: `${prefix}topstreak`,
                playerId: ctx.players[0].playerId,
            });
            const event = await waitForEvent(client, {
                eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
                gameserverId: ctx.gameServer.id,
                after: topBefore,
                timeout: 30000,
            });
            assert.ok(event, 'Expected a command-executed event');
            const meta = event.meta;
            assert.equal(meta?.result?.success, true, 'Expected /topstreak to succeed after claims');
            const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
            // Assert the log contains the player count (total=1 since only player[0] claimed)
            assert.ok(logMessages.some((msg) => msg.includes('top') && msg.includes('players') && msg.includes('total)')), `Expected leaderboard log with player count, got: ${JSON.stringify(logMessages)}`);
        }
        finally {
            await cleanupRole(client, claimRoleId);
        }
    });
    it('should respect count argument', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}topstreak 5`,
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
        assert.equal(meta?.result?.success, true, 'Expected /topstreak 5 to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('of 5 requested')), `Expected log to confirm count=5 was respected, got: ${JSON.stringify(logMessages)}`);
    });
});
