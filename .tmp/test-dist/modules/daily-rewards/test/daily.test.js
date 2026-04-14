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
// player[0] has DAILY_CLAIM permission (for basic tests + cooldown test)
// player[1] has no permissions (for permission denied test)
// player[2] gets DAILY_CLAIM + DAILY_REWARD_MULTIPLIER count=3 only for multiplier test
describe('daily-rewards: /daily command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    let claimRoleId;
    before(async () => {
        client = await createClient();
        await cleanupTestModules(client);
        await cleanupTestGameServers(client);
        ctx = await startMockServer(client);
        // Enable economy for currency operations
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
                showMultiplierInClaim: true,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        // Assign DAILY_CLAIM permission to player[0] only
        claimRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['DAILY_CLAIM']);
    });
    after(async () => {
        await cleanupRole(client, claimRoleId);
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
    it('should claim daily reward successfully on first claim (streak=1, reward=100)', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}daily`,
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
        assert.ok(logMessages.some((msg) => msg.includes('streak=1') && msg.includes('reward=100')), `Expected streak=1 and reward=100, got: ${JSON.stringify(logMessages)}`);
    });
    it('should reject second claim within 24h with cooldown message', async () => {
        // Depends on previous test: player[0] just claimed their daily
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}daily`,
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
        assert.equal(meta?.result?.success, false, 'Expected command to fail on cooldown');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('already claimed') || msg.includes('Come back')), `Expected cooldown message, got: ${JSON.stringify(logMessages)}`);
    });
    it('should deny claim without DAILY_CLAIM permission', async () => {
        // player[1] has no permissions
        const player = ctx.players[1];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}daily`,
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
        assert.ok(logMessages.some((msg) => msg.includes('do not have permission')), `Expected permission denied message, got: ${JSON.stringify(logMessages)}`);
    });
    it('should apply multiplier to daily reward (streak=1, multiplier=3, reward=300)', async () => {
        // Use player[2] — a fresh player who has never claimed, guaranteeing streak=1
        // Assign both DAILY_CLAIM and DAILY_REWARD_MULTIPLIER (count=3) in one role
        const player = ctx.players[2];
        const multiplierRoleId = await assignPermissions(client, player.playerId, ctx.gameServer.id, [
            { code: 'DAILY_CLAIM' },
            { code: 'DAILY_REWARD_MULTIPLIER', count: 3 },
        ]);
        try {
            const before = new Date();
            await client.command.commandControllerTrigger(ctx.gameServer.id, {
                msg: `${prefix}daily`,
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
            assert.equal(meta?.result?.success, true, 'Expected command to succeed with multiplier');
            const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
            assert.ok(logMessages.some((msg) => msg.includes('multiplier=3') && msg.includes('reward=300')), `Expected multiplier=3 and reward=300, got: ${JSON.stringify(logMessages)}`);
        }
        finally {
            await cleanupRole(client, multiplierRoleId);
        }
    });
});
