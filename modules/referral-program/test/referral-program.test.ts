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

type EventLike = { meta?: { result?: { logs?: Array<{ msg: string }>; success?: boolean } } };
type ReferralLink = {
  referrerId: string;
  status: string;
  playtimeAtLink?: number;
  retries?: number;
  rewardType?: string;
  rewardAmount?: number;
  payoutReason?: string;
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
  let resetCronjobId: string;
  let aliceCode: string;
  let aliceName: string;
  let bobName: string;
  let malloryName: string;

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
    resetCronjobId = setup.resetCronjobId;
    [aliceName, bobName, malloryName] = await harness.getPlayerNames();
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

    const missingCodeEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, 'referral');
    assert.equal(parseSuccess(missingCodeEvent), false, 'Expected /referral without code to fail');
    assert.ok(parseLogs(missingCodeEvent).some((msg) => msg.includes('Usage: /referral <code>')));

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
        [{ code: 'REFERRAL_VIP', count: 3 } as PermissionInput],
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
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 575, 'Expected VIP payout');

    const leaderboard = await harness.triggerCommand(harness.ctx.players[0].playerId, 'reftop');
    assert.equal(parseSuccess(leaderboard), true, 'Expected /reftop to succeed');
    assert.ok(parseLogs(leaderboard).some((msg) => msg.includes(`1. ${aliceName} — paid=2, total=2`)));
  });

  it('admin unlink rolls back earnings, then reflink pays immediately', async () => {
    const unlinkEvent = await harness.triggerCommand(harness.ctx.players[2].playerId, `refunlink ${bobName}`);
    assert.equal(parseSuccess(unlinkEvent), true, 'Expected /refunlink to succeed');

    const bobLinkAfterUnlink = await harness.getVariable(`${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`, harness.ctx.players[1].playerId);
    assert.equal(bobLinkAfterUnlink, null, 'Expected Bob link to be deleted');

    const aliceStats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsTotal, 1, 'Expected total referrals to decrement');
    assert.equal(aliceStats?.referralsPaid, 1, 'Expected paid referrals to decrement');
    assert.equal(aliceStats?.currencyEarned, 575, 'Expected earnings rollback for removed paid referral');

    const malloryCurrencyBefore = await harness.getCurrency(harness.ctx.players[2].playerId);
    const bobCurrencyBefore = await harness.getCurrency(harness.ctx.players[1].playerId);
    const linkEvent = await harness.triggerCommand(harness.ctx.players[2].playerId, `reflink ${bobName} ${malloryName}`);
    assert.equal(parseSuccess(linkEvent), true, 'Expected /reflink to succeed');

    const bobCurrencyAfter = await harness.getCurrency(harness.ctx.players[1].playerId);
    assert.equal(bobCurrencyAfter, bobCurrencyBefore + 100, 'Expected admin reflink welcome bonus');

    const malloryCurrencyAfter = await harness.getCurrency(harness.ctx.players[2].playerId);
    assert.equal(malloryCurrencyAfter, malloryCurrencyBefore + 500, 'Expected immediate admin payout');

    const bobLink = await harness.getVariableValue<ReferralLink>(
      `${REFERRAL_LINK_PREFIX}${harness.ctx.players[1].playerId}`,
      harness.ctx.players[1].playerId,
    );
    assert.equal(bobLink?.status, 'paid');
    assert.equal(bobLink?.referrerId, harness.ctx.players[2].playerId);
    assert.equal(bobLink?.rewardAmount, 500);
  });

  it('disconnect hook pays pending referrals and reset cron clears daily counts', async () => {
    const unlinkEvent = await harness.triggerCommand(harness.ctx.players[2].playerId, `refunlink ${bobName}`);
    assert.equal(parseSuccess(unlinkEvent), true, 'Expected unlink before disconnect scenario to succeed');

    const malloryStats = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[2].playerId}`,
      harness.ctx.players[2].playerId,
    );
    assert.equal(malloryStats?.currencyEarned, 0, 'Expected admin unlink to roll back Mallory earnings');
    assert.equal(malloryStats?.referralsPaid, 0, 'Expected admin unlink to roll back Mallory paid count');

    const bobCurrencyBefore = await harness.getCurrency(harness.ctx.players[1].playerId);
    const referralEvent = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(referralEvent), true, 'Expected Bob to link again');
    const bobCurrencyAfterClaim = await harness.getCurrency(harness.ctx.players[1].playerId);
    assert.equal(bobCurrencyAfterClaim, bobCurrencyBefore + 100, 'Expected second welcome bonus');

    await harness.forceReferralProgress(harness.ctx.players[1].playerId, 130);
    const aliceCurrencyBefore = await harness.getCurrency(harness.ctx.players[0].playerId);
    const hookEvent = await harness.triggerDisconnectHook(harness.ctx.players[1].playerId);
    assert.equal(parseSuccess(hookEvent), true, 'Expected disconnect hook to succeed');
    assert.ok(parseLogs(hookEvent).some((msg) => msg.includes('disconnect hook') && msg.includes('"paid":true')));

    const aliceCurrencyAfter = await harness.getCurrency(harness.ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 575, 'Expected VIP payout through disconnect hook');

    const aliceStatsKey = `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`;
    const aliceStats = await harness.getVariableValue<Record<string, unknown>>(aliceStatsKey, harness.ctx.players[0].playerId);
    await harness.setVariableValue(aliceStatsKey, {
      ...aliceStats,
      referralsToday: 3,
      lastReferralDay: '1999-12-31',
    }, harness.ctx.players[0].playerId);

    const resetEvent = await harness.triggerCron(resetCronjobId);
    assert.equal(parseSuccess(resetEvent), true, 'Expected reset cronjob to succeed');

    const resetStats = await harness.getVariableValue<ReferralStats>(aliceStatsKey, harness.ctx.players[0].playerId);
    assert.equal(resetStats?.referralsToday, 0);

    const refstatsEvent = await harness.triggerCommand(harness.ctx.players[0].playerId, 'refstats');
    assert.equal(parseSuccess(refstatsEvent), true, 'Expected /refstats to succeed');
    assert.ok(parseLogs(refstatsEvent).some((msg) => msg.includes('Referrals: total=2, paid=2, pending=0')));
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
    const commands = ['refcode', 'refstats', 'reftop', 'referral ABC123'];
    for (const command of commands) {
      const event = await harness.triggerCommand(harness.ctx.players[0].playerId, command);
      assert.equal(parseSuccess(event), false, `Expected ${command} to be denied`);
      assert.ok(parseLogs(event).some((msg) => msg.includes('do not have permission')), `Expected permission denial for ${command}`);
    }
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
    assert.ok(parseLogs(event).some((msg) => msg.includes('only claim a referral within 0 hours')));
  });
});

describe('referral-program module — missing POG validation', () => {
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

  it('rejects referrals when the player-on-gameserver record is missing', async () => {
    await harness.client.playerOnGameserver.playerOnGameServerControllerDelete(
      harness.ctx.gameServer.id,
      harness.ctx.players[1].playerId,
    );

    const event = await harness.triggerCommand(harness.ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(event), false, 'Expected missing POG rejection');
    assert.ok(parseLogs(event).some((msg) => msg.includes('Could not load your player record')));
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
    assert.equal(parseSuccess(unlinkEvent), true, 'Expected item referral unlink to succeed');
    const aliceAfterUnlink = await harness.getVariableValue<ReferralStats>(
      `${REFERRAL_STATS_PREFIX}${harness.ctx.players[0].playerId}`,
      harness.ctx.players[0].playerId,
    );
    assert.equal(aliceAfterUnlink?.itemsEarned, 0, 'Expected unlink to roll back item earnings');
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
        items: [{ item: 'stone', amount: 3 }],
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
  });
});
