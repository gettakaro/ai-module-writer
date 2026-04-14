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
describe('lottery: /lotteryinfo command', () => {
    let client;
    let ctx;
    let moduleId;
    let versionId;
    let prefix;
    let buyRoleId;
    before(async () => {
        client = await createClient();
        await cleanupTestModules(client);
        await cleanupTestGameServers(client);
        ctx = await startMockServer(client);
        // Enable economy
        await client.settings.settingsControllerSet('economyEnabled', {
            gameServerId: ctx.gameServer.id,
            value: 'true',
        });
        const mod = await pushModule(client, MODULE_DIR);
        moduleId = mod.id;
        versionId = mod.latestVersion.id;
        await installModule(client, versionId, ctx.gameServer.id, {
            userConfig: {
                ticketPrice: 10,
                profitMargin: 0.1,
                maxTicketsPerPlayer: 100,
                minimumParticipants: 2,
                announceTicketPurchases: false,
                rolloverOnCancel: false,
            },
        });
        prefix = await getCommandPrefix(client, ctx.gameServer.id);
        // Assign LOTTERY_BUY to player[0] for the ticket purchase test
        buyRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['LOTTERY_BUY']);
        // Give player[0] currency for purchases
        await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[0].playerId, { currency: 500 });
    });
    after(async () => {
        await cleanupRole(client, buyRoleId);
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
    it('should show empty pot when no participants', async () => {
        const player = ctx.players[0];
        const before = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}lotteryinfo`,
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
        assert.equal(meta?.result?.success, true, 'Expected lotteryinfo to succeed');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        assert.ok(logMessages.some((msg) => msg.includes('lottery-info:') && msg.includes('participants=0')), `Expected log to show participants=0, got: ${JSON.stringify(logMessages)}`);
    });
    it('should show pot and participants after ticket purchases', async () => {
        const player = ctx.players[0];
        // First buy some tickets
        const buyBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}buyticket 3`,
            playerId: player.playerId,
        });
        await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: buyBefore,
            timeout: 30000,
        });
        // Now check lotteryinfo
        const infoBefore = new Date();
        await client.command.commandControllerTrigger(ctx.gameServer.id, {
            msg: `${prefix}lotteryinfo`,
            playerId: player.playerId,
        });
        const event = await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: ctx.gameServer.id,
            after: infoBefore,
            timeout: 30000,
        });
        assert.ok(event, 'Expected a command-executed event');
        const meta = event.meta;
        assert.equal(meta?.result?.success, true, 'Expected lotteryinfo to succeed after purchases');
        const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
        // After buying 3 tickets at price 10 each, pot should be 30
        assert.ok(logMessages.some((msg) => msg.includes('lottery-info:') && msg.includes('participants=1')), `Expected log to show participants=1, got: ${JSON.stringify(logMessages)}`);
        assert.ok(logMessages.some((msg) => msg.includes('totalTickets=3')), `Expected totalTickets=3 in log, got: ${JSON.stringify(logMessages)}`);
    });
});
