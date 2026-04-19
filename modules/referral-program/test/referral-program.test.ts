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

function parseLogs(event: unknown): string[] {
  const meta = (event as { meta?: { result?: { logs?: Array<{ msg: string }> } } }).meta;
  return (meta?.result?.logs ?? []).map((l) => l.msg);
}

function parseSuccess(event: unknown): boolean {
  const meta = (event as { meta?: { result?: { success?: boolean } } }).meta;
  return meta?.result?.success ?? false;
}

describe('referral-program module', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let sweepCronjobId: string;
  let resetCronjobId: string;
  let disconnectHookId: string;
  let useRoleIds: string[] = [];
  let adminRoleId: string | undefined;
  let vipRoleId: string | undefined;
  let aliceName: string;
  let bobName: string;
  let malloryName: string;
  let aliceCode: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const names = await Promise.all(
      ctx.players.map(async (p) => {
        const res = await client.player.playerControllerGetOne(p.playerId);
        return res.data.data.name;
      }),
    );
    [aliceName, bobName, malloryName] = names;

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
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

    prefix = await getCommandPrefix(client, ctx.gameServer.id);
    sweepCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'sweep-pending-referrals')!.id;
    resetCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'reset-daily-counters')!.id;
    disconnectHookId = mod.latestVersion.hooks.find((h) => h.name === 'on-player-disconnect')!.id;

    useRoleIds = await Promise.all(
      ctx.players.map((p) => assignPermissions(client, p.playerId, ctx.gameServer.id, ['REFERRAL_USE'])),
    );
    adminRoleId = await assignPermissions(client, ctx.players[2].playerId, ctx.gameServer.id, ['REFERRAL_ADMIN']);
  });

  after(async () => {
    for (const roleId of useRoleIds) await cleanupRole(client, roleId);
    await cleanupRole(client, adminRoleId);
    await cleanupRole(client, vipRoleId);
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

  async function setVariableValue(key: string, value: unknown, playerId?: string) {
    const variable = await getVariable(key, playerId);
    if (!variable) throw new Error(`Variable not found: ${key}`);
    await client.variable.variableControllerUpdate(variable.id, { value: JSON.stringify(value) });
  }

  async function getPog(playerId: string) {
    const res = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [playerId],
      },
    });
    return res.data.data[0]!;
  }

  async function getCurrency(playerId: string): Promise<number> {
    const pog = await getPog(playerId);
    return pog.currency;
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

  it('generates a referral code and shows it to the player', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, 'refcode');
    assert.equal(parseSuccess(event), true, 'Expected /refcode to succeed');

    const logs = parseLogs(event);
    assert.ok(logs.some((msg) => msg.includes('generated/refetched code')), `Expected code generation log, got: ${JSON.stringify(logs)}`);

    const codeVar = await getVariableValue<{ code: string }>(`${REFERRAL_CODE_PREFIX}${ctx.players[0].playerId}`, ctx.players[0].playerId);
    assert.ok(codeVar?.code, 'Expected referral code variable to exist for Alice');
    aliceCode = codeVar!.code;
  });

  it('rejects referrals when the referrer has hit the daily cap, then allows a valid referral', async () => {
    const aliceStatsKey = `${REFERRAL_STATS_PREFIX}${ctx.players[0].playerId}`;
    const existingStats = await getVariableValue<Record<string, unknown>>(aliceStatsKey, ctx.players[0].playerId);
    if (!existingStats) {
      await client.variable.variableControllerCreate({
        key: aliceStatsKey,
        value: JSON.stringify({
          referralsTotal: 0,
          referralsPaid: 0,
          referralsToday: 5,
          lastReferralDay: new Date().toISOString().slice(0, 10),
          currencyEarned: 0,
          itemsEarned: 0,
        }),
        gameServerId: ctx.gameServer.id,
        moduleId,
        playerId: ctx.players[0].playerId,
      });
    } else {
      await setVariableValue(aliceStatsKey, {
        ...existingStats,
        referralsToday: 5,
        lastReferralDay: new Date().toISOString().slice(0, 10),
      }, ctx.players[0].playerId);
    }

    const denied = await triggerCommand(ctx.players[2].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(denied), false, 'Expected /referral to fail at daily cap');
    assert.ok(
      parseLogs(denied).some((msg) => msg.includes('daily referral limit')),
      `Expected daily cap message, got: ${JSON.stringify(parseLogs(denied))}`,
    );

    await setVariableValue(aliceStatsKey, {
      referralsTotal: 0,
      referralsPaid: 0,
      referralsToday: 0,
      lastReferralDay: null,
      currencyEarned: 0,
      itemsEarned: 0,
    }, ctx.players[0].playerId);

    const bobCurrencyBefore = await getCurrency(ctx.players[1].playerId);
    const event = await triggerCommand(ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(event), true, 'Expected Bob referral claim to succeed');
    assert.ok(
      parseLogs(event).some((msg) => msg.includes('linked referee')),
      `Expected referral link log, got: ${JSON.stringify(parseLogs(event))}`,
    );

    const bobCurrencyAfter = await getCurrency(ctx.players[1].playerId);
    assert.equal(bobCurrencyAfter, bobCurrencyBefore + 100, 'Expected Bob to receive 100 welcome currency');

    const bobLink = await getVariableValue<{ status: string; referrerId: string; playtimeAtLink: number }>(
      `${REFERRAL_LINK_PREFIX}${ctx.players[1].playerId}`,
      ctx.players[1].playerId,
    );
    assert.equal(bobLink?.status, 'pending', 'Expected Bob referral link to be pending');
    assert.equal(bobLink?.referrerId, ctx.players[0].playerId, 'Expected Alice to be Bob\'s referrer');

    const aliceStats = await getVariableValue<{ referralsTotal: number; referralsToday: number }>(
      `${REFERRAL_STATS_PREFIX}${ctx.players[0].playerId}`,
      ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsTotal, 1, 'Expected Alice total referrals to increment');
    assert.equal(aliceStats?.referralsToday, 1, 'Expected Alice daily referrals to increment');
  });

  it('rejects self-referral and relinking an already linked referee', async () => {
    const selfReferral = await triggerCommand(ctx.players[0].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(selfReferral), false, 'Expected self-referral to fail');
    assert.ok(
      parseLogs(selfReferral).some((msg) => msg.includes('cannot use your own referral code')),
      `Expected self-referral message, got: ${JSON.stringify(parseLogs(selfReferral))}`,
    );

    const relink = await triggerCommand(ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(relink), false, 'Expected relink to fail');
    assert.ok(
      parseLogs(relink).some((msg) => msg.includes('already have a referral link')),
      `Expected relink message, got: ${JSON.stringify(parseLogs(relink))}`,
    );
  });

  it('pays the referrer via cron sweep after the referee reaches the threshold', async () => {
    await forceReferralProgress(ctx.players[1].playerId, 61);
    const aliceCurrencyBefore = await getCurrency(ctx.players[0].playerId);

    const event = await triggerCron(sweepCronjobId);
    assert.equal(parseSuccess(event), true, 'Expected sweep cronjob to succeed');
    assert.ok(
      parseLogs(event).some((msg) => msg.includes(`referee=${ctx.players[1].playerId}`) && msg.includes('"paid":true')),
      `Expected paid sweep log, got: ${JSON.stringify(parseLogs(event))}`,
    );

    const aliceCurrencyAfter = await getCurrency(ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 500, 'Expected Alice to receive base payout of 500');

    const bobLink = await getVariableValue<{ status: string }>(`${REFERRAL_LINK_PREFIX}${ctx.players[1].playerId}`, ctx.players[1].playerId);
    assert.equal(bobLink?.status, 'paid', 'Expected Bob link to move to paid');

    const aliceStats = await getVariableValue<{ referralsPaid: number; currencyEarned: number }>(
      `${REFERRAL_STATS_PREFIX}${ctx.players[0].playerId}`,
      ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsPaid, 1, 'Expected Alice paid referral count to increment');
    assert.equal(aliceStats?.currencyEarned, 500, 'Expected Alice currencyEarned to track payout');
  });

  it('applies VIP multiplier and shows Alice on top of /reftop', async () => {
    vipRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      [{ code: 'REFERRAL_VIP', count: 3 } as PermissionInput],
    );

    const malloryCurrencyBefore = await getCurrency(ctx.players[2].playerId);
    const referralEvent = await triggerCommand(ctx.players[2].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(referralEvent), true, 'Expected Mallory referral claim to succeed');

    const malloryCurrencyAfterClaim = await getCurrency(ctx.players[2].playerId);
    assert.equal(malloryCurrencyAfterClaim, malloryCurrencyBefore + 100, 'Expected Mallory welcome bonus');

    await forceReferralProgress(ctx.players[2].playerId, 61);
    const aliceCurrencyBefore = await getCurrency(ctx.players[0].playerId);
    const sweepEvent = await triggerCron(sweepCronjobId);
    assert.equal(parseSuccess(sweepEvent), true, 'Expected sweep cronjob to succeed for VIP payout');

    const aliceCurrencyAfter = await getCurrency(ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 575, 'Expected Alice to receive 500 * 1.15 with VIP tier 3');

    const leaderboard = await triggerCommand(ctx.players[0].playerId, 'reftop');
    assert.equal(parseSuccess(leaderboard), true, 'Expected /reftop to succeed');
    assert.ok(
      parseLogs(leaderboard).some((msg) => msg.includes(`1. ${aliceName} — paid=2, total=2`)),
      `Expected Alice to top leaderboard, got: ${JSON.stringify(parseLogs(leaderboard))}`,
    );
  });

  it('admin commands can unlink and relink a referral immediately', async () => {
    const unlinkEvent = await triggerCommand(ctx.players[2].playerId, `refunlink ${bobName}`);
    assert.equal(parseSuccess(unlinkEvent), true, 'Expected /refunlink to succeed');

    const bobLinkAfterUnlink = await getVariable(`${REFERRAL_LINK_PREFIX}${ctx.players[1].playerId}`, ctx.players[1].playerId);
    assert.equal(bobLinkAfterUnlink, null, 'Expected Bob link variable to be deleted after unlink');

    const aliceStats = await getVariableValue<{ referralsTotal: number; referralsPaid: number }>(
      `${REFERRAL_STATS_PREFIX}${ctx.players[0].playerId}`,
      ctx.players[0].playerId,
    );
    assert.equal(aliceStats?.referralsTotal, 1, 'Expected Alice total referrals to decrement after unlink');
    assert.equal(aliceStats?.referralsPaid, 1, 'Expected Alice paid referrals to decrement after unlink');

    const malloryCurrencyBefore = await getCurrency(ctx.players[2].playerId);
    const bobCurrencyBefore = await getCurrency(ctx.players[1].playerId);
    const linkEvent = await triggerCommand(ctx.players[2].playerId, `reflink ${bobName} ${malloryName}`);
    assert.equal(parseSuccess(linkEvent), true, 'Expected /reflink to succeed');

    const bobCurrencyAfter = await getCurrency(ctx.players[1].playerId);
    assert.equal(bobCurrencyAfter, bobCurrencyBefore + 100, 'Expected admin reflink to pay Bob welcome bonus');

    const malloryCurrencyAfter = await getCurrency(ctx.players[2].playerId);
    assert.equal(malloryCurrencyAfter, malloryCurrencyBefore + 500, 'Expected admin reflink to pay Mallory immediately');

    const bobLink = await getVariableValue<{ status: string; referrerId: string }>(`${REFERRAL_LINK_PREFIX}${ctx.players[1].playerId}`, ctx.players[1].playerId);
    assert.equal(bobLink?.status, 'paid', 'Expected admin link to be marked paid immediately');
    assert.equal(bobLink?.referrerId, ctx.players[2].playerId, 'Expected Mallory to become Bob\'s referrer after admin link');
  });

  it('disconnect hook pays pending referrals when threshold is reached and reset cron clears daily counts', async () => {
    const unlinkEvent = await triggerCommand(ctx.players[2].playerId, `refunlink ${bobName}`);
    assert.equal(parseSuccess(unlinkEvent), true, 'Expected unlink before disconnect-hook scenario to succeed');

    const bobCurrencyBefore = await getCurrency(ctx.players[1].playerId);
    const referralEvent = await triggerCommand(ctx.players[1].playerId, `referral ${aliceCode}`);
    assert.equal(parseSuccess(referralEvent), true, 'Expected Bob to link again for disconnect hook scenario');
    const bobCurrencyAfterClaim = await getCurrency(ctx.players[1].playerId);
    assert.equal(bobCurrencyAfterClaim, bobCurrencyBefore + 100, 'Expected welcome bonus on second Bob referral');

    await forceReferralProgress(ctx.players[1].playerId, 130);
    const aliceCurrencyBefore = await getCurrency(ctx.players[0].playerId);
    const hookEvent = await triggerDisconnectHook(ctx.players[1].playerId);
    assert.equal(parseSuccess(hookEvent), true, 'Expected disconnect hook to succeed');
    assert.ok(
      parseLogs(hookEvent).some((msg) => msg.includes('disconnect hook') && msg.includes('"paid":true')),
      `Expected disconnect hook payout log, got: ${JSON.stringify(parseLogs(hookEvent))}`,
    );

    const aliceCurrencyAfter = await getCurrency(ctx.players[0].playerId);
    assert.equal(aliceCurrencyAfter, aliceCurrencyBefore + 575, 'Expected VIP payout through disconnect hook');

    const aliceStatsKey = `${REFERRAL_STATS_PREFIX}${ctx.players[0].playerId}`;
    const aliceStats = await getVariableValue<Record<string, unknown>>(aliceStatsKey, ctx.players[0].playerId);
    await setVariableValue(aliceStatsKey, {
      ...aliceStats,
      referralsToday: 3,
      lastReferralDay: '1999-12-31',
    }, ctx.players[0].playerId);

    const resetEvent = await triggerCron(resetCronjobId);
    assert.equal(parseSuccess(resetEvent), true, 'Expected reset daily counters cronjob to succeed');

    const resetStats = await getVariableValue<{ referralsToday: number }>(aliceStatsKey, ctx.players[0].playerId);
    assert.equal(resetStats?.referralsToday, 0, 'Expected reset daily counters cronjob to zero daily referrals');

    const refstatsEvent = await triggerCommand(ctx.players[0].playerId, 'refstats');
    assert.equal(parseSuccess(refstatsEvent), true, 'Expected /refstats to succeed');
    assert.ok(
      parseLogs(refstatsEvent).some((msg) => msg.includes('Referral code:') && msg.includes('Referrals: total=2, paid=2, pending=0')),
      `Expected refstats summary, got: ${JSON.stringify(parseLogs(refstatsEvent))}`,
    );
  });
});
