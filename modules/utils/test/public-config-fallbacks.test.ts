import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer, MockServerContext } from '../../../test/helpers/mock-server.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import {
  pushModule,
  installModule,
  uninstallModule,
  deleteModule,
  getCommandPrefix,
  cleanupTestModules,
  cleanupTestGameServers,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('utils: public config fallbacks', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;

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
        discordLink: '   ',
        rules: ['   ', ''],
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);
  });

  after(async () => {
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function trigger(playerId: string, msg: string) {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, { msg, playerId });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  }

  it('discord shows an unconfigured fallback when blank', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}discord`);
    assert.equal(res.success, true, `Expected command to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(
      res.logs.some((msg) => msg.includes('This server has not configured a Discord link.')),
      JSON.stringify(res.logs),
    );
  });

  it('rules shows an unconfigured fallback when all rules are blank', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}rules`);
    assert.equal(res.success, true, `Expected command to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(
      res.logs.some((msg) => msg.includes('This server has not configured any rules yet.')),
      JSON.stringify(res.logs),
    );
  });
});
