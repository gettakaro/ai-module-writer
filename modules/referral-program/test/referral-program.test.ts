import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, EventSearchInputAllowedFiltersEventNameEnum, HookTriggerDTOEventTypeEnum } from '@takaro/apiclient';
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
  assignPermissions,
  cleanupRole,
  PermissionInput,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

const REFERRAL_CODE_PREFIX = 'referral_code:';
const REFERRAL_LINK_PREFIX = 'referral_link:';
const REFERRAL_STATS_PREFIX = 'referral_stats:';
const REFERRAL_PENDING_INDEX_KEY = 'referral_pending_index';
const REFERRAL_PAYOUT_LOCK_PREFIX = 'referral_payout_lock:';

type EventLike = { meta?: { result?: { logs?: Array<{ msg: string }>; success?: boolean } } };
type ReferralLink = {
  referrerId: string;
  status: string;
  playtimeAtLink?: number;
  retries?: number;
  rewardType?: string;
  rewardAmount?: number;
  payoutReason?: string;
  rewardGranted?: boolean;
};

type ReferralStats = {
  referralsTotal: number;
  referralsPaid: number;
  referralsToday: number;
  lastReferralDay: string | null;
  currencyEarned: number;
  itemsEarned: number;
};

function parseLogs(event: unknown): string[] {
  return (((event as EventLike).meta?.result?.logs) ?? []).map((l) => l.msg);
}

function parseSuccess(event: unknown): boolean {
  return (event as EventLike).meta?.result?.success ?? false;
}

function defaultStats(overrides: Partial<ReferralStats> = {}): ReferralStats {
  return {
    referralsTotal: 0,
    referralsPaid: 0,
    referralsToday: 0,
    lastReferralDay: null,
    currencyEarned: 0,
    itemsEarned: 0,
    ...overrides,
  };
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function waitForBotConnection(baseUrl: string, botName: string, timeoutMs = 30000) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const status = await fetchJson(`${baseUrl}/status`) as Record<string, { connected?: boolean }>;
    if (status?.[botName]?.connected) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Bot ${botName} did not connect within ${timeoutMs}ms`);
}

async function waitForRealPlayer(client: Client, gameServerId: string, username: string, timeoutMs = 30000) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const players = await client.player.playerControllerSearch({ search: { name: [username] }, limit: 10 });
    const exact = players.data.data.find((player) => player.name === username);
    if (exact) {
      const pogs = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: {
          gameServerId: [gameServerId],
          playerId: [exact.id],
        },
        limit: 1,
      });
      if (pogs.data.data[0]) {
        return { playerId: exact.id, pogId: pogs.data.data[0].id };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Player ${username} did not appear on gameserver ${gameServerId} within ${timeoutMs}ms`);
}

function createHarness() {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;

  async function setup(userConfig: Record<string, unknown>, assigner?: (args: { client: Client; ctx: MockServerContext; gameServerId: string }) => Promise<void>) {
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

    await installModule(client, versionId, ctx.gameServer.id, { userConfig });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    if (assigner) {
      await assigner({ client, ctx, gameServerId: ctx.gameServer.id });
    }

    return {
      client,
      ctx,
      moduleId,
      versionId,
      prefix,
      sweepCronjobId: mod.latestVersion.cronJobs.find((c) => c.name === 'sweep-pending-referrals')!.id,
      resetCronjobId: mod.latestVersion.cronJobs.find((c) => c.name === 'reset-daily-counters')!.id,
      disconnectHookId: mod.latestVersion.hooks.find((h) => h.name === 'on-player-disconnect')!.id,
    };
  }

  async function cleanup(roleIds: Array<string | undefined> = []) {
    for (const roleId of roleIds) await cleanupRole(client, roleId);
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
  }

  async function triggerCommand(playerId: string, command: string) {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}${command}`,
      playerId,
    });
    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
  }

  async function triggerCron(cronjobId: string) {
    const before = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId,
      moduleId,
    });
    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
  }

  async function triggerDisconnectHook(playerId: string) {
    const before = new Date();
    await client.hook.hookControllerTrigger({
      gameServerId: ctx.gameServer.id,
      moduleId,
      playerId,
      eventType: HookTriggerDTOEventTypeEnum.PlayerDisconnected,
      eventMeta: {},
    });
    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
  }

  async function getVariable(key: string, playerId?: string) {
    const filters: Record<string, string[]> = {
      key: [key],
      gameServerId: [ctx.gameServer.id],
      moduleId: [moduleId],
    };
    if (playerId) filters.playerId = [playerId];
    const res = await client.variable.variableControllerSearch({ filters });
    return res.data.data[0] ?? null;
  }

  async function getVariableValue<T>(key: string, playerId?: string): Promise<T | null> {
    const variable = await getVariable(key, playerId);
    return variable ? JSON.parse(variable.value) as T : null;
  }

  async function upsertVariableValue(key: string, value: unknown, playerId?: string) {
    const existing = await getVariable(key, playerId);
    if (existing) {
      await client.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(value) });
      return existing.id;
    }

    const payload: Record<string, unknown> = {
      key,
      value: JSON.stringify(value),
      gameServerId: ctx.gameServer.id,
      moduleId,
    };
    if (playerId) payload.playerId = playerId;
    const created = await client.variable.variableControllerCreate(payload as never);
    return created.data.data.id;
  }

  async function setVariableValue(key: string, value: unknown, playerId?: string) {
    const existing = await getVariable(key, playerId);
    if (!existing) throw new Error(`Variable not found: ${key}`);
    await client.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(value) });
  }

  async function getPog(playerId: string) {
    const res = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [playerId],
      },
      limit: 1,
    });
    return res.data.data[0] ?? null;
  }

  async function getCurrency(playerId: string): Promise<number> {
    const pog = await getPog(playerId);
    return pog?.currency ?? 0;
  }

  async function forceReferralProgress(refereePlayerId: string, earnedMinutes: number) {
    const key = `${REFERRAL_LINK_PREFIX}${refereePlayerId}`;
    const link = await getVariableValue<Record<string, unknown>>(key, refereePlayerId);
    assert.ok(link, `Expected referral link for ${refereePlayerId} to exist`);
    await setVariableValue(key, {
      ...link,
      playtimeAtLink: -earnedMinutes,
    }, refereePlayerId);
  }

  async function getPlayerNames() {
    return Promise.all(
      ctx.players.map(async (p) => {
        const res = await client.player.playerControllerGetOne(p.playerId);
        return res.data.data.name;
      }),
    );
  }

  return {
    setup,
    cleanup,
    triggerCommand,
    triggerCron,
    triggerDisconnectHook,
    getVariable,
    getVariableValue,
    upsertVariableValue,
    setVariableValue,
    getPog,
    getCurrency,
    forceReferralProgress,
    getPlayerNames,
    get client() { return client; },
    get ctx() { return ctx; },
    get moduleId() { return moduleId; },
  };
}

describe('referral-program module — currency flow and admin repair', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let sweepCronjobId: string;
  let aliceCode: string;
  let aliceName: string;
  let bobName: string;

  before(async () => {
    const setup = await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[2].playerId, gameServerId, ['REFERRAL_USE', 'REFERRAL_ADMIN']));
      },
    );

    sweepCronjobId = setup.sweepCronjobId;
    [aliceName, bobName] = await harness.getPlayerNames();
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('generates a referral code and rejects missing and unknown referral codes', async () => {
    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true, 'Expected /refcode to succeed');
    assert.ok(parseLogs(codeEvent).some((msg) => msg.includes('generated/refetched code')));

    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.ok(codeVar?.code, 'Expected referral code variable for Alice');
    aliceCode = codeVar!.code;

    const missingCodeEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, 'referral ""');
    assert.equal(parseSuccess(missingCodeEvent), false, 'Expected /referral without code to fail');
    assert.ok(parseLogs(missingCodeEvent).some((msg) => msg.includes('Usage: /referral <code>') || msg.includes('Usage: referral <code>')));

    const unknownCodeEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, 'referral NOPE42');
    assert.equal(parseSuccess(unknownCodeEvent), false, 'Expected unknown referral code to fail');
    assert.ok(parseLogs(unknownCodeEvent).some((msg) => msg.includes('was not found')));
  });

  it('rejects referrals when the referrer has hit daily or lifetime caps, then allows a valid referral', async () => {
    const aliceStatsKey = `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`;

    await harness.upsertVariableValue(
      aliceStatsKey,
      defaultStats({
        referralsToday: 5,
        lastReferralDay: new Date().toISOString().slice(0, 10),
      }),
      harness.ctx.players[0].playerId,
    );

    const dailyCap = await harness.triggerCommand(harness.ctx.players[2].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(dailyCap), false, 'Expected daily cap rejection');
    assert.ok(parseLogs(dailyCap).some((msg) => msg.includes('daily referral limit')));

    await harness.setVariableValue(
      aliceStatsKey,
      defaultStats({
        referralsTotal: 50,
      }),
      harness.ctx.players[0].playerId,
    );

    const lifetimeCap = await harness.triggerCommand(harness.ctx.players[2].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(lifetimeCap), false, 'Expected lifetime cap rejection');
    assert.ok(parseLogs(lifetimeCap).some((msg) => msg.includes('lifetime referral limit')));

    await harness.setVariableValue(aliceStatsKey, defaultStats(), harness.ctx.players[0].playerId);

    const bobCurrencyBefore = await harness.getCurrency(harness.ctx.players[1].playerId);
    const referralEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(referralEvent), true, 'Expected valid referral to succeed');
    assert.ok(parseLogs(referralEvent).some((msg) => msg.includes('linked referee')));

    const bobCurrencyAfter = await harness.getCurrency(harness.ctx.players[1].playerId);
    assert.equal(bobCurrencyAfter, bobCurrencyBefore + 100, 'Expected Bob welcome bonus');

    const bobLink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(bobLink?.status, 'pending');
    assert.equal(bobLink?.referrerId, harness.ctx.players[0].playerId);

    const aliceStats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsTotal, 1);
    assert.equal(aliceStats?.referralsToday, 1);
  });

  it('rejects self-referral and relinking an already linked referee', async () => {
    const selfReferral = await harness.triggerCommand(harness.ctx.players[0].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(selfReferral), false, 'Expected self-referral rejection');
    assert.ok(parseLogs(selfReferral).some((msg) => msg.includes('cannot use your own referral code')));

    const relink = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(relink), false, 'Expected relink rejection');
    assert.ok(parseLogs(relink).some((msg) => msg.includes('already have a referral link')));
  });

  it('pays the referrer via cron sweep after the referee reaches the threshold', async () => {
    await harness.forceReferralProgress(harness.ctx.players[1].playerId, 61);
    const aliceCurrencyBefore = await harness.getCurrency(harness.ctx.players[0].playerId);

    const event = await harness.triggerCron(sweepCronjobId);
    assert.equal(parseSuccess(event), true, 'Expected sweep cronjob to succeed');
    assert.ok(parseLogs(event).some((msg) => msg.includes(`referee=${harness.ctx.players[1].playerId}`) && msg.includes('"paid":true')));

    const aliceCurrencyAfter = await harness.getCurrency(harness.ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 500, 'Expected base payout');

    const bobLink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(bobLink?.status, 'paid');
    assert.equal(bobLink?.rewardType, 'currency');
    assert.equal(bobLink?.rewardAmount, 500);

    const aliceStats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsPaid, 1);
    assert.equal(aliceStats?.currencyEarned, 500);
  });

  it('applies VIP multiplier and shows Alice on top of /reftop', async () => {
    roleIds.push(
      await assignPermissions(
        harness.client,
        harness.ctx.players[0].playerId,
        harness.ctx.gameServer.id,
        [{ code: 'REFERRAL_VIP', count: 9 } as PermissionInput],
      ),
    );

    const malloryCurrencyBefore = await harness.getCurrency(harness.ctx.players[2].playerId);
    const referralEvent = await harness.triggerCommand(harness.ctx.players[2].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(referralEvent), true, 'Expected Mallory referral claim to succeed');

    const malloryCurrencyAfterClaim = await harness.getCurrency(harness.ctx.players[2].playerId);
    assert.equal(malloryCurrencyAfterClaim, malloryCurrencyBefore + 100, 'Expected Mallory welcome bonus');

    await harness.forceReferralProgress(harness.ctx.players[2].playerId, 61);
    const aliceCurrencyBefore = await harness.getCurrency(harness.ctx.players[0].playerId);
    const sweepEvent = await harness.triggerCron(sweepCronjobId);
    assert.equal(parseSuccess(sweepEvent), true, 'Expected sweep cronjob to succeed for VIP payout');

    const aliceCurrencyAfter = await harness.getCurrency(harness.ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 625, 'Expected VIP payout capped at +25%');

    const leaderboard = await harness.triggerCommand(harness.ctx.players[0].playerId, 'reftop');
    assert.equal(parseSuccess(leaderboard), true, 'Expected /reftop to succeed');
    assert.ok(parseLogs(leaderboard).some((msg) => msg.includes(`1. ${aliceName} — paid=2, total=2`)));
  });

  it('lets admins unlink a paid currency referral and claw back both players\' rewards', async () => {
    const aliceCurrencyBefore = await harness.getCurrency(harness.ctx.players[0].playerId);
    const bobCurrencyBefore = await harness.getCurrency(harness.ctx.players[1].playerId);

    const unlinkEvent = await harness.triggerCommand(harness.ctx.players[2].playerId, `refunlink ${bobName}`);
    assert.equal(parseSuccess(unlinkEvent), true, 'Expected /refunlink to roll back paid currency referrals');

    const aliceCurrencyAfter = await harness.getCurrency(harness.ctx.players[0].playerId);
    const bobCurrencyAfter = await harness.getCurrency(harness.ctx.players[1].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore - 500, 'Expected referrer payout clawback');
    assert.equal(bobCurrencyAfter, bobCurrencyBefore - 100, 'Expected referee welcome bonus clawback');

    const bobLink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(bobLink, null, 'Expected /refunlink to delete the paid referral link');

    const aliceStats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsTotal, 1);
    assert.equal(aliceStats?.referralsPaid, 1);
    assert.equal(aliceStats?.currencyEarned, 575);
  });

});

describe('referral-program module — permission denials', () => {
  const harness = createHarness();

  before(async () => {
    await harness.setup({
      prizeIsCurrency: true,
      referrerCurrencyReward: 500,
      refereeCurrencyReward: 100,
      items: [],
      playtimeThresholdMinutes: 60,
      referralWindowHours: 24,
      maxReferralsPerDay: 5,
      maxReferralsLifetime: 50,
    });
  });

  after(async () => {
    await harness.cleanup();
  });

  it('denies REFERRAL_USE commands without the permission', async () => {
    for (const command of ['refcode', 'refstats', 'reftop']) {
      const event = await harness.triggerCommand(harness.ctx.players[0].playerId, command);
      assert.equal(parseSuccess(event), false, `Expected /${command} denial`);
      assert.ok(parseLogs(event).some((msg) => msg.includes('do not have permission')));
    }

    const referral = await harness.triggerCommand(harness.ctx.players[0].playerId, 'referral ABC123');
    assert.equal(parseSuccess(referral), false, 'Expected /referral denial');
    assert.ok(parseLogs(referral).some((msg) => msg.includes('do not have permission')));
  });

  it('denies REFERRAL_ADMIN commands without the permission', async () => {
    const reflink = await harness.triggerCommand(harness.ctx.players[0].playerId, 'reflink someone else');
    assert.equal(parseSuccess(reflink), false, 'Expected /reflink denial');
    assert.ok(parseLogs(reflink).some((msg) => msg.includes('do not have permission')));

    const refunlink = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refunlink someone');
    assert.equal(parseSuccess(refunlink), false, 'Expected /refunlink denial');
    assert.ok(parseLogs(refunlink).some((msg) => msg.includes('do not have permission')));
  });
});

describe('referral-program module — expired window validation', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let aliceCode: string;

  before(async () => {
    await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 0,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );

    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true);
    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    aliceCode = codeVar!.code;
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('rejects referrals outside the allowed window', async () => {
    const event = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(event), false, 'Expected expired referral window rejection');
    assert.ok(parseLogs(event).some((msg) => msg.includes('Referral claims are disabled on this server right now')));
  });
});

describe('referral-program module — missing POG payout handling', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let aliceCode: string;
  let sweepCronjobId: string;

  before(async () => {
    const setup = await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );

    sweepCronjobId = setup.sweepCronjobId;
    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true);
    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    aliceCode = codeVar!.code;
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('leaves the referral pending when the payout path cannot load the referee POG', async () => {
    const claim = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(claim), true, 'Expected initial referral claim to succeed');
    await harness.forceReferralProgress(harness.ctx.players[1].playerId, 80);

    await harness.client.playerOnGameserver.playerOnGameServerControllerDelete(
      harness.ctx.gameServer.id,
      harness.ctx.players[1].playerId,
    );

    const sweepEvent = await harness.triggerCron(sweepCronjobId);
    assert.equal(parseSuccess(sweepEvent), true, 'Expected sweep to complete even without a referee POG');
    assert.ok(parseLogs(sweepEvent).some((msg) => msg.includes('missing-pog')));

    const link = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(link?.status, 'pending');

    const stats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(stats?.referralsPaid, 0);
  });
});

describe('referral-program module — admin command validation and repair flows', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let bobName: string;
  let malloryName: string;

  before(async () => {
    await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE', 'REFERRAL_ADMIN']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[2].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );

    [, bobName, malloryName] = await harness.getPlayerNames();
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('covers missing arguments, lookup failures, self-link rejection, cap enforcement, duplicate-link rejection, and missing-link unlink rejection', async () => {
    const usage = await harness.triggerCommand(harness.ctx.players[0].playerId, 'reflink "" ""');
    assert.equal(parseSuccess(usage), false);
    assert.ok(parseLogs(usage).some((msg) => msg.includes('Usage: /reflink <referee> <referrer>') || msg.includes('Usage: reflink <referee> <referrer>')));

    const missingReferee = await harness.triggerCommand(harness.ctx.players[0].playerId, 'reflink no_such_player also_missing');
    assert.equal(parseSuccess(missingReferee), false);
    assert.ok(parseLogs(missingReferee).some((msg) => msg.includes('Referee')));

    const missingReferrer = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${bobName} also_missing`);
    assert.equal(parseSuccess(missingReferrer), false);
    assert.ok(parseLogs(missingReferrer).some((msg) => msg.includes('Referrer')));

    const selfLink = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${bobName} ${bobName}`);
    assert.equal(parseSuccess(selfLink), false);
    assert.ok(parseLogs(selfLink).some((msg) => msg.includes('must be different players')));

    const missingUnlink = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refunlink ""');
    assert.equal(parseSuccess(missingUnlink), false);
    assert.ok(parseLogs(missingUnlink).some((msg) => msg.includes('Usage: /refunlink <referee>') || msg.includes('Usage: refunlink <referee>')));

    const noLink = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${bobName}`);
    assert.equal(parseSuccess(noLink), false);
    assert.ok(parseLogs(noLink).some((msg) => msg.includes('does not have a referral link')));

    await harness.upsertVariableValue(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[2].playerId}`,
      defaultStats({
        referralsToday: 5,
        lastReferralDay: new Date().toISOString().slice(0, 10),
      }),
      harness.ctx.players[2].playerId,
    );
    const cappedReflink = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${bobName} ${malloryName}`);
    assert.equal(parseSuccess(cappedReflink), false);
    assert.ok(parseLogs(cappedReflink).some((msg) => msg.includes('daily referral limit')));

    await harness.setVariableValue(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[2].playerId}`,
      defaultStats(),
      harness.ctx.players[2].playerId,
    );

    const initialLink = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${bobName} ${malloryName}`);
    assert.equal(parseSuccess(initialLink), true);

    const duplicateLink = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${bobName} ${malloryName}`);
    assert.equal(parseSuccess(duplicateLink), false);
    assert.ok(parseLogs(duplicateLink).some((msg) => msg.includes('already has a referral link')));
  });

  it('covers pending unlink rollback plus reflink immediate payout and paid unlink repair', async () => {
    const bobCodeEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, 'refcode');
    assert.equal(parseSuccess(bobCodeEvent), true);
    const bobCodeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.ok(bobCodeVar?.code);

    const malloryCurrencyStart = await harness.getCurrency(harness.ctx.players[2].playerId);
    const bobCurrencyStart = await harness.getCurrency(harness.ctx.players[1].playerId);

    const pendingClaim = await harness.triggerCommand(harness.ctx.players[2].playerId, `referral ${bobCodeVar!.code}`);
    assert.equal(parseSuccess(pendingClaim), true, 'Expected manual referral claim to succeed before unlink');

    const pendingIndexAfterClaim = await harness.getVariableValue<string[]>(REFERRAL_PENDING_INDEX_KEY);
    assert.ok(pendingIndexAfterClaim?.includes(harness.ctx.players[2].playerId));

    const pendingUnlink = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${malloryName}`);
    assert.equal(parseSuccess(pendingUnlink), true, 'Expected /refunlink to roll back a pending referral');

    const malloryCurrencyAfterPendingUnlink = await harness.getCurrency(harness.ctx.players[2].playerId);
    assert.equal(malloryCurrencyAfterPendingUnlink, malloryCurrencyStart, 'Expected pending unlink to claw back the welcome bonus');

    const pendingIndexAfterUnlink = await harness.getVariableValue<string[]>(REFERRAL_PENDING_INDEX_KEY);
    assert.ok(!pendingIndexAfterUnlink?.includes(harness.ctx.players[2].playerId));

    const linkAfterPendingUnlink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[2].playerId}`,
      harness.ctx.players[2].playerId,
    );
    assert.equal(linkAfterPendingUnlink, null, 'Expected pending unlink to delete the referral link');

    const statsAfterPendingUnlink = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(statsAfterPendingUnlink?.referralsTotal ?? 0, 0);
    assert.equal(statsAfterPendingUnlink?.referralsPaid ?? 0, 0);

    const reflinkEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${malloryName} ${bobName}`);
    assert.equal(parseSuccess(reflinkEvent), true, 'Expected /reflink to pay immediately on the happy path');

    const malloryCurrencyAfterReflink = await harness.getCurrency(harness.ctx.players[2].playerId);
    const bobCurrencyAfterReflink = await harness.getCurrency(harness.ctx.players[1].playerId);
    assert.equal(malloryCurrencyAfterReflink, malloryCurrencyStart + 100, 'Expected /reflink to repay the welcome bonus after rollback');
    assert.equal(bobCurrencyAfterReflink, bobCurrencyStart + 500, 'Expected /reflink to pay the referrer immediately');

    const paidLink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[2].playerId}`,
      harness.ctx.players[2].playerId,
    );
    assert.equal(paidLink?.status, 'paid');
    assert.equal(paidLink?.rewardType, 'currency');
    assert.equal(paidLink?.rewardAmount, 500);

    const pendingIndexAfterReflink = await harness.getVariableValue<string[]>(REFERRAL_PENDING_INDEX_KEY);
    assert.ok(!pendingIndexAfterReflink?.includes(harness.ctx.players[2].playerId), 'Expected paid reflink to remove the pending index entry');

    const statsAfterReflink = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(statsAfterReflink?.referralsTotal, 1);
    assert.equal(statsAfterReflink?.referralsPaid, 1);
    assert.equal(statsAfterReflink?.currencyEarned, 500);

    const paidUnlink = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${malloryName}`);
    assert.equal(parseSuccess(paidUnlink), true, 'Expected /refunlink to reverse a paid currency repair flow');

    const malloryCurrencyAfterPaidUnlink = await harness.getCurrency(harness.ctx.players[2].playerId);
    const bobCurrencyAfterPaidUnlink = await harness.getCurrency(harness.ctx.players[1].playerId);
    assert.equal(malloryCurrencyAfterPaidUnlink, malloryCurrencyStart);
    assert.equal(bobCurrencyAfterPaidUnlink, bobCurrencyStart);

    const linkAfterPaidUnlink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[2].playerId}`,
      harness.ctx.players[2].playerId,
    );
    assert.equal(linkAfterPaidUnlink, null);

    const statsAfterPaidUnlink = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(statsAfterPaidUnlink?.referralsTotal, 0);
    assert.equal(statsAfterPaidUnlink?.referralsPaid, 0);
    assert.equal(statsAfterPaidUnlink?.currencyEarned, 0);
  });

  it('refuses to unlink a paid referral when the full reward cannot be clawed back', async () => {
    const paidLink = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${malloryName} ${bobName}`);
    assert.equal(parseSuccess(paidLink), true, 'Expected setup /reflink to succeed');

    await harness.client.playerOnGameserver.playerOnGameServerControllerSetCurrency(
      harness.ctx.gameServer.id,
      harness.ctx.players[1].playerId,
      { currency: 0 },
    );

    const partialUnlink = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${malloryName}`);
    assert.equal(parseSuccess(partialUnlink), false, 'Expected /refunlink to fail when clawback would be partial');
    assert.ok(parseLogs(partialUnlink).some((msg) => msg.includes('full reward amount available for clawback')));

    const linkAfterFailure = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[2].playerId}`,
      harness.ctx.players[2].playerId,
    );
    assert.equal(linkAfterFailure?.status, 'paid');

    await harness.client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      harness.ctx.gameServer.id,
      harness.ctx.players[1].playerId,
      { currency: 500 },
    );
    const cleanup = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${malloryName}`);
    assert.equal(parseSuccess(cleanup), true, 'Expected cleanup unlink once clawback is possible again');
  });

  it('keeps admin repair flows consistent when payouts are in progress or explicitly deferred', async () => {
    await harness.upsertVariableValue(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[2].playerId}`,
      {
        referrerId: harness.ctx.players[1].playerId,
        linkedAt: new Date().toISOString(),
        status: 'paying',
        playtimeAtLink: 0,
        retries: 1,
        rewardType: 'currency',
        rewardAmount: 500,
        payoutReason: 'test-paying',
        rewardGranted: false,
      },
      harness.ctx.players[2].playerId,
    );

    const payingUnlink = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${malloryName}`);
    assert.equal(parseSuccess(payingUnlink), false, 'Expected /refunlink to refuse links still in paying state');
    assert.ok(parseLogs(payingUnlink).some((msg) => msg.includes('still being finalized')));

    await harness.client.variable.variableControllerDelete(
      (await harness.getVariable(`${REFERRAL_LINK_PREFIX}${harness.ctx.players[2].playerId}`, harness.ctx.players[2].playerId))!.id,
    );

    await harness.upsertVariableValue(
      `${REFERRAL_PAYOUT_LOCK_PREFIX}${harness.ctx.players[2].playerId}`,
      {
        ownerToken: 'test-lock',
        acquiredAt: new Date().toISOString(),
      },
    );

    const deferredReflink = await harness.triggerCommand(harness.ctx.players[0].playerId, `reflink ${malloryName} ${bobName}`);
    assert.equal(parseSuccess(deferredReflink), true, 'Expected /reflink to succeed even when payout finalization is deferred');
    assert.ok(parseLogs(deferredReflink).some((msg) => msg.includes('payout deferred=payout-in-progress')));

    const deferredLink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[2].playerId}`,
      harness.ctx.players[2].playerId,
    );
    assert.equal(deferredLink?.status, 'pending');

    const deferredStats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(deferredStats?.referralsTotal, 1);
    assert.equal(deferredStats?.referralsPaid, 0);

    await harness.client.variable.variableControllerDelete(
      (await harness.getVariable(`${REFERRAL_PAYOUT_LOCK_PREFIX}${harness.ctx.players[2].playerId}`))!.id,
    );

    const cleanupUnlink = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${malloryName}`);
    assert.equal(parseSuccess(cleanupUnlink), true, 'Expected deferred admin link to remain repairable');
  });
});

describe('referral-program module — disconnect hook and reset cron', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let aliceCode: string;
  let resetCronjobId: string;

  before(async () => {
    const setup = await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, [
          { code: 'REFERRAL_USE' },
          { code: 'REFERRAL_VIP', count: 3 },
        ]));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );

    resetCronjobId = setup.resetCronjobId;
    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true);
    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    aliceCode = codeVar!.code;
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('pays through the disconnect hook, records payout progress, and clears stale daily counters in /refstats and via cron', async () => {
    const referralEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(referralEvent), true);

    await harness.forceReferralProgress(harness.ctx.players[1].playerId, 130);
    const aliceCurrencyBefore = await harness.getCurrency(harness.ctx.players[0].playerId);
    const progressEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, 'refstats');
    assert.equal(parseSuccess(progressEvent), true);
    assert.ok(parseLogs(progressEvent).some((msg) => msg.includes('Qualifying progress:')));
    assert.ok(parseLogs(progressEvent).some((msg) => msg.includes('0.0 remaining')));

    const hookEvent = await harness.triggerDisconnectHook(harness.ctx.players[1].playerId);
    assert.equal(parseSuccess(hookEvent), true);
    assert.ok(parseLogs(hookEvent).some((msg) => msg.includes('disconnect hook') && msg.includes('"paid":true')));
    assert.ok(parseLogs(hookEvent).some((msg) => msg.includes('payout notification')));

    const aliceCurrencyAfter = await harness.getCurrency(harness.ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 575);

    const aliceStatsKey = `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`;
    const aliceStats = await harness.getVariableValue<Record<string, unknown>>(aliceStatsKey, harness.ctx.players[0].playerId);
    await harness.setVariableValue(aliceStatsKey, {
      ...aliceStats,
      referralsToday: 3,
      lastReferralDay: '1999-12-31',
    }, harness.ctx.players[0].playerId);

    const refstatsEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refstats');
    assert.equal(parseSuccess(refstatsEvent), true);
    assert.ok(parseLogs(refstatsEvent).some((msg) => msg.includes('today=0')));

    const resetEvent = await harness.triggerCron(resetCronjobId);
    assert.equal(parseSuccess(resetEvent), true);

    const resetStats = await harness.getVariableValue<ReferralStats>(aliceStatsKey, harness.ctx.players[0].playerId);
    assert.equal(resetStats?.referralsToday, 0);
  });
});

describe('referral-program module — empty states and no-bonus messaging', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let aliceCode: string;

  before(async () => {
    await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 0,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );

    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true);
    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    aliceCode = codeVar!.code;
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('shows the leaderboard empty state and omits a zero-value welcome bonus from success messaging', async () => {
    const emptyLeaderboard = await harness.triggerCommand(harness.ctx.players[0].playerId, 'reftop');
    assert.equal(parseSuccess(emptyLeaderboard), true);
    assert.ok(parseLogs(emptyLeaderboard).some((msg) => msg.includes('leaderboard empty')));

    const referralEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(referralEvent), true);
    assert.ok(!parseLogs(referralEvent).some((msg) => msg.includes('You received 0 welcome currency')));
  });
});

describe('referral-program module — concurrent payout guard', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let sweepCronjobId: string;
  let aliceCode: string;

  before(async () => {
    const setup = await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );
    sweepCronjobId = setup.sweepCronjobId;

    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true);
    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    aliceCode = codeVar!.code;
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('awards the referral only once when sweep and disconnect race each other', async () => {
    const claim = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(claim), true);
    await harness.forceReferralProgress(harness.ctx.players[1].playerId, 90);

    const aliceCurrencyBefore = await harness.getCurrency(harness.ctx.players[0].playerId);
    const [cronEvent, hookEvent] = await Promise.all([
      harness.triggerCron(sweepCronjobId),
      harness.triggerDisconnectHook(harness.ctx.players[1].playerId),
    ]);
    assert.equal(parseSuccess(cronEvent), true);
    assert.equal(parseSuccess(hookEvent), true);

    const aliceCurrencyAfter = await harness.getCurrency(harness.ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 500, 'Expected exactly one payout despite concurrent triggers');

    const link = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(link?.status, 'paid');
  });
});

describe('referral-program module — crash-recovery payout resume', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let sweepCronjobId: string;

  before(async () => {
    const setup = await harness.setup(
      {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );
    sweepCronjobId = setup.sweepCronjobId;

    await harness.upsertVariableValue(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      {
        referrerId: harness.ctx.players[0].playerId,
        linkedAt: new Date().toISOString(),
        status: 'paying',
        playtimeAtLink: 0,
        retries: 1,
        rewardType: 'currency',
        rewardAmount: 500,
        vipTier: 0,
        vipMultiplier: 1,
        payoutReason: 'test-resume',
        payoutPreparedAt: new Date().toISOString(),
        rewardGranted: true,
        rewardGrantedAt: new Date().toISOString(),
      },
      harness.ctx.players[1].playerId,
    );
    await harness.upsertVariableValue(REFERRAL_PENDING_INDEX_KEY, [harness.ctx.players[1].playerId]);
    await harness.upsertVariableValue(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      defaultStats({ referralsTotal: 1 }),
      harness.ctx.players[0].playerId,
    );
    await harness.client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      harness.ctx.gameServer.id,
      harness.ctx.players[0].playerId,
      { currency: 500 },
    );
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('resumes and finalizes a prepared payout exactly once', async () => {
    const aliceCurrencyBefore = await harness.getCurrency(harness.ctx.players[0].playerId);
    const sweepEvent = await harness.triggerCron(sweepCronjobId);
    assert.equal(parseSuccess(sweepEvent), true);
    assert.ok(parseLogs(sweepEvent).some((msg) => msg.includes('resuming payout finalization')));

    const aliceCurrencyAfter = await harness.getCurrency(harness.ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore, 'Resume should finalize stats/link without paying a second time');

    const link = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(link?.status, 'paid');

    const stats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(stats?.referralsPaid, 1);
    assert.equal(stats?.currencyEarned, 500);
  });
});

describe('referral-program module — item reward success path', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let sweepCronjobId: string;
  let aliceCode: string;
  let bobName: string;

  before(async () => {
    const setup = await harness.setup(
      {
        prizeIsCurrency: false,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [{ item: 'stone', amount: 3, quality: 'normal' }],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE', 'REFERRAL_ADMIN']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[2].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );

    sweepCronjobId = setup.sweepCronjobId;
    [, bobName] = await harness.getPlayerNames();

    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true);
    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    aliceCode = codeVar!.code;
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('awards configured items and tracks itemsEarned for paid referrals', async () => {
    const event = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(event), true, 'Expected Bob referral claim to succeed in item mode');

    await harness.forceReferralProgress(harness.ctx.players[1].playerId, 70);
    const sweepEvent = await harness.triggerCron(sweepCronjobId);
    assert.equal(parseSuccess(sweepEvent), true, 'Expected item payout sweep to succeed');
    assert.ok(parseLogs(sweepEvent).some((msg) => msg.includes('"paid":true')));

    const bobLink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(bobLink?.status, 'paid');
    assert.equal(bobLink?.rewardType, 'item');
    assert.equal(bobLink?.rewardAmount, 3);

    const aliceStats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsPaid, 1);
    assert.equal(aliceStats?.itemsEarned, 3);
    assert.equal(aliceStats?.currencyEarned, 0);

    const unlinkEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, `refunlink ${bobName}`);
    assert.equal(parseSuccess(unlinkEvent), false, 'Expected paid item referral unlink to be rejected');
    assert.ok(parseLogs(unlinkEvent).some((msg) => msg.includes('cannot be unlinked automatically') || msg.includes('cannot be unlinked')));
  });
});

describe('referral-program module — item payout retries and rejection', () => {
  const harness = createHarness();
  const roleIds: Array<string | undefined> = [];
  let sweepCronjobId: string;
  let aliceCode: string;

  before(async () => {
    const setup = await harness.setup(
      {
        prizeIsCurrency: false,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [{ item: 'definitely_not_a_real_item', amount: 3, quality: 'normal' }],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
      async ({ client, ctx, gameServerId }) => {
        roleIds.push(await assignPermissions(client, ctx.players[0].playerId, gameServerId, ['REFERRAL_USE']));
        roleIds.push(await assignPermissions(client, ctx.players[1].playerId, gameServerId, ['REFERRAL_USE']));
      },
    );

    sweepCronjobId = setup.sweepCronjobId;
    const codeEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(codeEvent), true);
    const codeVar = await harness.getVariableValue<{ code: string }>(
      `${REFERRAL_CODE_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    aliceCode = codeVar!.code;
  });

  after(async () => {
    await harness.cleanup(roleIds);
  });

  it('increments retries and eventually rejects misconfigured item payouts without leaking quota', async () => {
    const claim = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(claim), true, 'Expected referral claim before payout retries');
    await harness.forceReferralProgress(harness.ctx.players[1].playerId, 80);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const sweepEvent = await harness.triggerCron(sweepCronjobId);
      assert.equal(parseSuccess(sweepEvent), true, `Expected sweep attempt ${attempt} to finish`);
    }

    const link = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(link?.status, 'rejected', 'Expected referral to be rejected after repeated payout failures');
    assert.equal(link?.retries, 3, 'Expected retry counter to reach 3');

    const pendingIndex = await harness.getVariableValue<string[]>(REFERRAL_PENDING_INDEX_KEY);
    assert.ok(!pendingIndex?.includes(harness.ctx.players[1].playerId), 'Expected rejected referral to be removed from pending index');

    const stats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(stats?.referralsTotal, 0, 'Expected rejected payout to release lifetime quota');
    assert.equal(stats?.referralsPaid, 0);
    assert.equal(stats?.itemsEarned, 0);

    const refstats = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refstats');
    assert.equal(parseSuccess(refstats), true, 'Expected /refstats to succeed after rejection');
    assert.ok(parseLogs(refstats).some((msg) => msg.includes('Referrals: total=0, paid=0, pending=0')));
    assert.ok(parseLogs(refstats).some((msg) => msg.includes('Your referral status: needs admin help')));
    assert.ok(parseLogs(refstats).some((msg) => msg.includes('Payout issue: Reward delivery failed because the configured referral item is unavailable.')));
    assert.ok(!parseLogs(refstats).some((msg) => msg.includes('Configured referral reward item "definitely_not_a_real_item"')));
  });
});

describe('referral-program module — real Paper + bot verification', () => {
  let client: Client;
  let moduleId: string | undefined;
  let versionId: string | undefined;
  let gameServerId: string | undefined;
  const roleIds: Array<string | undefined> = [];
  const botBaseUrl = `http://localhost:${process.env.BOT_PORT || '3101'}`;
  const botNames = [`rpa${Date.now().toString(36).slice(-4)}`, `rpb${Date.now().toString(36).slice(-4)}`];

  after(async () => {
    await Promise.allSettled(botNames.map((name) => fetch(`${botBaseUrl}/bots/${name}`, { method: 'DELETE' })));
    for (const roleId of roleIds) {
      if (client) await cleanupRole(client, roleId);
    }
    if (client && moduleId && gameServerId) {
      try {
        await uninstallModule(client, moduleId, gameServerId);
      } catch (err) {
        console.error('Paper cleanup: failed to uninstall module:', err);
      }
    }
    if (client && moduleId) {
      try {
        await deleteModule(client, moduleId);
      } catch (err) {
        console.error('Paper cleanup: failed to delete module:', err);
      }
    }
  });

  it('exercises every referral command plus hook and cron through the real Paper server', async () => {
    await fetchJson(`${botBaseUrl}/status`);

    client = await createClient();
    const gsSearch = await client.gameserver.gameServerControllerSearch({ limit: 50, page: 0 });
    const paper = gsSearch.data.data.find((gs) => gs.identityToken === 'minecraft' || gs.name === 'minecraft');
    assert.ok(paper, 'Registered Paper game server not found');
    const realGameServerId = paper.id;
    gameServerId = realGameServerId;

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    await installModule(client, versionId, realGameServerId, {
      userConfig: {
        prizeIsCurrency: true,
        referrerCurrencyReward: 500,
        refereeCurrencyReward: 100,
        items: [],
        playtimeThresholdMinutes: 60,
        referralWindowHours: 24,
        maxReferralsPerDay: 5,
        maxReferralsLifetime: 50,
      },
    });

    const prefix = await getCommandPrefix(client, realGameServerId);
    const sweepCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'sweep-pending-referrals')!.id;
    const resetCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'reset-daily-counters')!.id;
    const disconnectHookId = mod.latestVersion.hooks.find((h) => h.name === 'on-player-disconnect')!.id;

    for (const name of botNames) {
      await fetchJson(`${botBaseUrl}/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      await waitForBotConnection(botBaseUrl, name);
    }

    const [referrerReal, refereeReal] = await Promise.all([
      waitForRealPlayer(client, realGameServerId, `Bot_${botNames[0]}`),
      waitForRealPlayer(client, realGameServerId, `Bot_${botNames[1]}`),
    ]);

    roleIds.push(await assignPermissions(client, referrerReal.playerId, realGameServerId, ['REFERRAL_USE', 'REFERRAL_ADMIN']));
    roleIds.push(await assignPermissions(client, refereeReal.playerId, realGameServerId, ['REFERRAL_USE']));

    await new Promise((resolve) => setTimeout(resolve, 8000));

    const sendBotCommand = async (botName: string, message: string) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const startedAt = new Date();
        await fetchJson(`${botBaseUrl}/bot/${botName}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });

        try {
          return await waitForEvent(client, {
            eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
            gameserverId: realGameServerId,
            after: startedAt,
            timeout: 20000,
          });
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
      }

      throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for command event for ${message}`);
    };

    const getLinkVariable = async () => {
      const result = await client.variable.variableControllerSearch({
        filters: {
          key: [`${REFERRAL_LINK_PREFIX}${refereeReal.playerId}`],
          gameServerId: [realGameServerId],
          moduleId: [moduleId!],
          playerId: [refereeReal.playerId],
        },
      });
      return result.data.data[0] ?? null;
    };

    const refcodeEvent = await sendBotCommand(botNames[0], `${prefix}refcode`);
    assert.equal(parseSuccess(refcodeEvent), true, 'Expected real bot /refcode to execute through Takaro');

    const referrerCode = await client.variable.variableControllerSearch({
      filters: {
        key: [`${REFERRAL_CODE_PREFIX}${referrerReal.playerId}`],
        gameServerId: [realGameServerId],
        moduleId: [moduleId!],
        playerId: [referrerReal.playerId],
      },
    });
    const code = JSON.parse(referrerCode.data.data[0].value).code as string;
    assert.ok(code, 'Expected real bot referrer code to be stored');

    const emptyTop = await sendBotCommand(botNames[0], `${prefix}reftop`);
    assert.equal(parseSuccess(emptyTop), true, 'Expected real bot /reftop to work before any payouts');

    const referralEvent = await sendBotCommand(botNames[1], `${prefix}referral ${code}`);
    assert.equal(parseSuccess(referralEvent), true, 'Expected real bot /referral to execute through Takaro');
    assert.ok(parseLogs(referralEvent).some((msg) => msg.includes('linked referee')));

    const pendingStats = await sendBotCommand(botNames[1], `${prefix}refstats`);
    assert.equal(parseSuccess(pendingStats), true, 'Expected real bot /refstats to work for the referee');
    assert.ok(parseLogs(pendingStats).some((msg) => msg.includes('pending qualification')));

    const linkVariable = await getLinkVariable();
    assert.ok(linkVariable, 'Expected real referral link to exist after /referral');
    const linkPayload = JSON.parse(linkVariable!.value) as Record<string, unknown>;
    await client.variable.variableControllerUpdate(linkVariable!.id, {
      value: JSON.stringify({
        ...linkPayload,
        playtimeAtLink: -61,
      }),
    });

    const hookStartedAt = new Date();
    await client.hook.hookControllerTrigger({
      gameServerId: realGameServerId,
      moduleId: moduleId!,
      playerId: refereeReal.playerId,
      eventType: HookTriggerDTOEventTypeEnum.PlayerDisconnected,
      eventMeta: {},
      hookId: disconnectHookId,
    } as never);
    const hookEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: realGameServerId,
      after: hookStartedAt,
      timeout: 20000,
    });
    assert.equal(parseSuccess(hookEvent), true, 'Expected real disconnect hook execution');
    assert.ok(parseLogs(hookEvent).some((msg) => msg.includes('disconnect hook') && msg.includes('"paid":true')));

    const paidTop = await sendBotCommand(botNames[0], `${prefix}reftop`);
    assert.equal(parseSuccess(paidTop), true, 'Expected real bot /reftop to reflect the paid referral');
    assert.ok(parseLogs(paidTop).some((msg) => msg.includes('paid=1')));

    const unlinkEvent = await sendBotCommand(botNames[0], `${prefix}refunlink Bot_${botNames[1]}`);
    assert.equal(parseSuccess(unlinkEvent), true, 'Expected real bot /refunlink to work after a paid referral');

    const relinkClaim = await sendBotCommand(botNames[1], `${prefix}referral ${code}`);
    assert.equal(parseSuccess(relinkClaim), true, 'Expected referee to be able to claim again after /refunlink');

    const relinkVar = await getLinkVariable();
    assert.ok(relinkVar, 'Expected new pending link before real cron verification');
    const relinkPayload = JSON.parse(relinkVar!.value) as Record<string, unknown>;
    await client.variable.variableControllerUpdate(relinkVar!.id, {
      value: JSON.stringify({
        ...relinkPayload,
        playtimeAtLink: -61,
      }),
    });

    const cronStartedAt = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: realGameServerId,
      cronjobId: sweepCronjobId,
      moduleId: moduleId!,
    });
    const sweepEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: realGameServerId,
      after: cronStartedAt,
      timeout: 20000,
    });
    assert.equal(parseSuccess(sweepEvent), true, 'Expected real sweep cronjob execution');
    assert.ok(parseLogs(sweepEvent).some((msg) => msg.includes('"paid":true')));

    const secondUnlink = await sendBotCommand(botNames[0], `${prefix}refunlink Bot_${botNames[1]}`);
    assert.equal(parseSuccess(secondUnlink), true, 'Expected second real /refunlink cleanup to work');

    const reflinkEvent = await sendBotCommand(botNames[0], `${prefix}reflink Bot_${botNames[1]} Bot_${botNames[0]}`);
    assert.equal(parseSuccess(reflinkEvent), true, 'Expected real bot /reflink repair flow to work');

    const postRepairStats = await sendBotCommand(botNames[0], `${prefix}refstats`);
    assert.equal(parseSuccess(postRepairStats), true, 'Expected real bot /refstats to work after /reflink');

    const resetStartedAt = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: realGameServerId,
      cronjobId: resetCronjobId,
      moduleId: moduleId!,
    });
    const resetEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: realGameServerId,
      after: resetStartedAt,
      timeout: 20000,
    });
    assert.equal(parseSuccess(resetEvent), true, 'Expected real reset cronjob execution');
  });
});
