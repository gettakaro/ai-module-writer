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
  assignPermissions,
  cleanupRole,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

const DISABLED_CRONS = {
  startRace: { enabled: false },
  recoverRunningRace: { enabled: false },
  announceRace: { enabled: false },
};

async function installRacingModule(
  client: Client,
  versionId: string,
  gameServerId: string,
  config?: { userConfig?: Record<string, unknown>; systemConfig?: Record<string, unknown> },
): Promise<void> {
  const systemConfig = {
    ...(config?.systemConfig ?? {}),
    cronJobs: {
      ...DISABLED_CRONS,
      ...((config?.systemConfig as { cronJobs?: Record<string, unknown> } | undefined)?.cronJobs ?? {}),
    },
  };
  await installModule(client, versionId, gameServerId, {
    userConfig: config?.userConfig,
    systemConfig,
  });
}

type ExecutionResult = {
  success: boolean;
  logs: string[];
};

type RaceState = {
  status?: 'betting' | 'running';
  raceNumber: number;
  nextRaceTime: number;
  startedAt?: number;
  finishAt?: number;
  startRunId?: string;
  frozenEntrants?: Array<{ name: string; odds: number }>;
  frozenBets?: Array<{ playerId: string; playerName: string; racer: string; odds: number; amount: number }>;
  plannedResults?: Array<{ name: string; odds: number; position: number }>;
  raceCommentary?: Array<{ stage: string; message: string; sentAt: number | null }>;
  bets: Array<{ playerId: string; playerName: string; racer: string; odds: number; amount: number }>;
  lastRaceResults?: RaceResult | null;
  completion?: {
    raceNumber: number;
    status: string;
    result: RaceResult;
    nextRaceData: RaceState;
    activeOwner?: string;
    activeExpiresAt?: number;
    payoutStartedPlayerIds?: string[];
    statsUpdatedPlayerIds?: string[];
    finalizedPlayerIds?: string[];
  } | null;
};

type RaceResult = {
  raceNumber: number;
  results: Array<{ name: string; odds: number; position: number }>;
  winner: string;
  bets: RaceState['bets'];
  winners: Array<RaceState['bets'][number] & { payout: number }>;
  totalBets: number;
  totalWagered: number;
  totalPayout: number;
  jackpot: number;
  timestamp: number;
};

type PlayerRaceStats = {
  playerName: string;
  totalWinnings: number;
  totalBets: number;
  totalWagered: number;
  wins: number;
  losses: number;
  biggestWin: number;
  favoriteRacer: string;
  racerStats: Record<string, { bets: number; wins: number; totalWagered: number }>;
  processedStatIds?: string[];
};

describe('zombie-racing: commands and race flow', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let startRaceCronjobId: string;
  let recoverRunningRaceCronjobId: string;
  let betAdminRoleId: string | undefined;
  let betOnlyRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client, { totalPlayers: 2 });

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        minBet: 25,
        maxBet: 250,
      },
      systemConfig: {
        hooks: {
          raceCommentaryEarlyAfterScheduledStart: { delay: 10 },
          raceCommentaryMiddleAfterScheduledStart: { delay: 15 },
          raceCommentaryLateAfterScheduledStart: { delay: 20 },
          raceCommentaryEarlyAfterManualStart: { delay: 2 },
          raceCommentaryMiddleAfterManualStart: { delay: 4 },
          raceCommentaryLateAfterManualStart: { delay: 6 },
          finishRaceAfterScheduledStart: { delay: 30 },
          finishRaceAfterManualStart: { delay: 20 },
        },
      },
    });

    const startRaceCronjob = mod.latestVersion.cronJobs.find((cronjob) => cronjob.name === 'startRace');
    assert.ok(startRaceCronjob, 'Expected startRace cronjob to be present');
    startRaceCronjobId = startRaceCronjob.id;
    const recoverRunningRaceCronjob = mod.latestVersion.cronJobs.find((cronjob) => cronjob.name === 'recoverRunningRace');
    assert.ok(recoverRunningRaceCronjob, 'Expected recoverRunningRace cronjob to be present');
    recoverRunningRaceCronjobId = recoverRunningRaceCronjob.id;
    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    betAdminRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, [
      'RACING_BET',
      'RACING_ADMIN',
    ]);
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 300 },
    );
  });

  after(async () => {
    await cleanupRole(client, betAdminRoleId);
    await cleanupRole(client, betOnlyRoleId);
    if (moduleId && ctx?.gameServer?.id) {
      try {
        await uninstallModule(client, moduleId, ctx.gameServer.id);
      } catch (err) {
        console.error('Cleanup: failed to uninstall zombie-racing module:', err);
      }
    }
    if (moduleId) {
      try {
        await deleteModule(client, moduleId);
      } catch (err) {
        console.error('Cleanup: failed to delete zombie-racing module:', err);
      }
    }
    if (ctx?.server) await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function triggerCommand(playerId: string, command: string): Promise<ExecutionResult> {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}${command}`,
      playerId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((log) => log.msg),
    };
  }

  async function triggerCronjob(cronjobId: string): Promise<ExecutionResult> {
    const before = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId,
      moduleId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((log) => log.msg),
    };
  }

  async function triggerStartRace(): Promise<ExecutionResult> {
    return triggerCronjob(startRaceCronjobId);
  }

  async function triggerRecoverRunningRace(): Promise<ExecutionResult> {
    let lastResult: ExecutionResult | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      lastResult = await triggerCronjob(recoverRunningRaceCronjobId);
      if (!lastResult.logs.some((msg) => msg.includes('Race state is busy'))) return lastResult;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return lastResult!;
  }

  async function waitForHookExecution(after: Date, marker: string): Promise<ExecutionResult> {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const result = await client.event.eventControllerSearch({
        filters: {
          eventName: [EventSearchInputAllowedFiltersEventNameEnum.HookExecuted],
          gameserverId: [ctx.gameServer.id],
        },
        greaterThan: {
          createdAt: after.toISOString(),
        },
      });
      for (const event of result.data.data) {
        const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
        const logs = (meta?.result?.logs ?? []).map((log) => log.msg);
        if (logs.some((msg) => msg.includes(marker) && !msg.includes('skipped'))) {
          return {
            success: meta?.result?.success ?? false,
            logs,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for hook marker '${marker}'`);
  }

  async function waitForEvents(eventName: EventSearchInputAllowedFiltersEventNameEnum, after: Date, count: number) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await client.event.eventControllerSearch({
        filters: {
          eventName: [eventName],
          gameserverId: [ctx.gameServer.id],
        },
        greaterThan: {
          createdAt: after.toISOString(),
        },
      });
      if (result.data.data.length >= count) return result.data.data;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${count} ${eventName} events`);
  }

  async function triggerCommandsConcurrently(commands: Array<{ playerId: string; command: string }>): Promise<ExecutionResult[]> {
    const before = new Date();
    await Promise.all(commands.map(({ playerId, command }) => client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}${command}`,
      playerId,
    })));
    const events = await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted, before, commands.length);
    return events.slice(0, commands.length).map((event) => {
      const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
      return {
        success: meta?.result?.success ?? false,
        logs: (meta?.result?.logs ?? []).map((log) => log.msg),
      };
    });
  }

  async function triggerRunRaceAndCommandConcurrently(commandPlayerId: string, command: string): Promise<ExecutionResult[]> {
    const cronBefore = new Date();
    const commandBefore = new Date();
    await Promise.all([
      client.cronjob.cronJobControllerTrigger({
        gameServerId: ctx.gameServer.id,
        cronjobId: startRaceCronjobId,
        moduleId,
      }),
      client.command.commandControllerTrigger(ctx.gameServer.id, {
        msg: `${prefix}${command}`,
        playerId: commandPlayerId,
      }),
    ]);
    const [cronEvent, commandEvent] = await Promise.all([
      waitForEvent(client, {
        eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
        gameserverId: ctx.gameServer.id,
        after: cronBefore,
        timeout: 30000,
      }),
      waitForEvent(client, {
        eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
        gameserverId: ctx.gameServer.id,
        after: commandBefore,
        timeout: 30000,
      }),
    ]);
    return [cronEvent, commandEvent].map((event) => {
      const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
      return {
        success: meta?.result?.success ?? false,
        logs: (meta?.result?.logs ?? []).map((log) => log.msg),
      };
    });
  }

  async function getRaceState(): Promise<RaceState> {
    const vars = await client.variable.variableControllerSearch({
      filters: {
        key: ['zombie_racing_state_v1'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    assert.ok(vars.data.data[0], 'Expected zombie racing state variable to exist');
    return JSON.parse(vars.data.data[0].value) as RaceState;
  }

  async function setRaceState(state: RaceState): Promise<void> {
    const vars = await client.variable.variableControllerSearch({
      filters: {
        key: ['zombie_racing_state_v1'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    assert.ok(vars.data.data[0], 'Expected zombie racing state variable to exist');
    await client.variable.variableControllerUpdate(vars.data.data[0].id, {
      value: JSON.stringify(state),
    });
  }

  async function getPlayerStats(playerId: string): Promise<PlayerRaceStats | null> {
    const vars = await client.variable.variableControllerSearch({
      filters: {
        key: ['zombie_racing_stats_v1'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        playerId: [playerId],
      },
    });
    if (!vars.data.data[0]) return null;
    return JSON.parse(vars.data.data[0].value) as PlayerRaceStats;
  }

  async function setPlayerStats(playerId: string, stats: PlayerRaceStats): Promise<void> {
    const vars = await client.variable.variableControllerSearch({
      filters: {
        key: ['zombie_racing_stats_v1'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        playerId: [playerId],
      },
    });
    if (vars.data.data[0]) {
      await client.variable.variableControllerUpdate(vars.data.data[0].id, {
        value: JSON.stringify(stats),
      });
      return;
    }

    await client.variable.variableControllerCreate({
      key: 'zombie_racing_stats_v1',
      value: JSON.stringify(stats),
      gameServerId: ctx.gameServer.id,
      moduleId,
      playerId,
    });
  }

  async function createStaleRaceLock(owner: string): Promise<void> {
    const vars = await client.variable.variableControllerSearch({
      filters: {
        key: ['zombie_racing_lock_v1'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    await Promise.all(vars.data.data.map((variable) => client.variable.variableControllerDelete(variable.id)));
    await client.variable.variableControllerCreate({
      key: 'zombie_racing_lock_v1',
      value: JSON.stringify({
        owner,
        reason: 'complete-race',
        acquiredAt: Date.now() - 60000,
        expiresAt: Date.now() - 30000,
      }),
      gameServerId: ctx.gameServer.id,
      moduleId,
    });
  }

  async function getCurrency(playerId: string): Promise<number> {
    const pog = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [playerId] },
    });
    return pog.data.data[0]?.currency ?? 0;
  }

  async function waitUntil(assertion: () => Promise<boolean>, label: string, timeout = 45000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await assertion()) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  it('lists default zombie-themed racers and bet limits', async () => {
    const result = await triggerCommand(ctx.players[0].playerId, 'racers');

    assert.equal(result.success, true, `Expected /racers to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('Zombie Race')), `Expected race name in logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('label=zombies')), `Expected zombie label in logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('Biker:2')), `Expected default entrant in logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('minBet=25') && msg.includes('maxBet=250')), `Expected configured limits in logs: ${JSON.stringify(result.logs)}`);
  });

  it('denies race betting without RACING_BET permission', async () => {
    const result = await triggerCommand(ctx.players[1].playerId, 'racebet Biker 50');

    assert.equal(result.success, false, 'Expected /racebet to fail without permission');
    assert.ok(result.logs.some((msg) => msg.includes('permission')), `Expected permission error, got: ${JSON.stringify(result.logs)}`);
  });

  it('validates entrant names and bet limits', async () => {
    const badEntrant = await triggerCommand(ctx.players[0].playerId, 'racebet Missing 50');
    assert.equal(badEntrant.success, false, 'Expected missing entrant to fail');
    assert.ok(badEntrant.logs.some((msg) => msg.includes('was not found')), `Expected entrant error, got: ${JSON.stringify(badEntrant.logs)}`);

    const tooSmall = await triggerCommand(ctx.players[0].playerId, 'racebet Biker 10');
    assert.equal(tooSmall.success, false, 'Expected too-small bet to fail');
    assert.ok(tooSmall.logs.some((msg) => msg.includes('between 25 and 250')), `Expected range error, got: ${JSON.stringify(tooSmall.logs)}`);

    const tooLarge = await triggerCommand(ctx.players[0].playerId, 'racebet Biker 300');
    assert.equal(tooLarge.success, false, 'Expected too-large bet to fail');
    assert.ok(tooLarge.logs.some((msg) => msg.includes('between 25 and 250')), `Expected range error, got: ${JSON.stringify(tooLarge.logs)}`);
  });

  it('rejects race betting when the player lacks currency', async () => {
    betOnlyRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, [
      'RACING_BET',
    ]);

    const result = await triggerCommand(ctx.players[1].playerId, 'racebet Biker 50');

    assert.equal(result.success, false, 'Expected insufficient currency to fail');
    assert.ok(result.logs.some((msg) => msg.includes("don't have enough currency")), `Expected currency error, got: ${JSON.stringify(result.logs)}`);
  });

  it('places a bet and replaces an existing bet with a refund', async () => {
    const player = ctx.players[0];

    const before = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
    });
    const startingCurrency = before.data.data[0]?.currency ?? 0;

    const firstBet = await triggerCommand(player.playerId, 'racebet Biker 250');
    assert.equal(firstBet.success, true, `Expected first bet to succeed, logs: ${JSON.stringify(firstBet.logs)}`);
    assert.ok(firstBet.logs.some((msg) => msg.includes('racing:racebet') && msg.includes('racer=Biker') && msg.includes('amount=250')), `Expected bet confirmation, got: ${JSON.stringify(firstBet.logs)}`);

    const replacementBet = await triggerCommand(player.playerId, 'racebet Arlene 100');
    assert.equal(replacementBet.success, true, `Expected replacement bet to succeed, logs: ${JSON.stringify(replacementBet.logs)}`);
    assert.ok(replacementBet.logs.some((msg) => msg.includes('add-currency')), `Expected refund API call, got: ${JSON.stringify(replacementBet.logs)}`);
    assert.ok(replacementBet.logs.some((msg) => msg.includes('racing:racebet') && msg.includes('racer=Arlene') && msg.includes('amount=100')), `Expected replacement confirmation, got: ${JSON.stringify(replacementBet.logs)}`);

    const after = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
    });
    const endingCurrency = after.data.data[0]?.currency ?? 0;
    assert.equal(endingCurrency, startingCurrency - 100, 'Expected old bet refund before replacement deduction');
  });

  it('shows current bets and next race without runtime errors', async () => {
    const bets = await triggerCommand(ctx.players[0].playerId, 'myracebets');
    assert.equal(bets.success, true, `Expected /myracebets to succeed, logs: ${JSON.stringify(bets.logs)}`);
    assert.ok(bets.logs.some((msg) => msg.includes('racing:myracebets') && msg.includes('racers=Arlene')), `Expected current bet output, got: ${JSON.stringify(bets.logs)}`);

    const nextRace = await triggerCommand(ctx.players[0].playerId, 'nextrace');
    assert.equal(nextRace.success, true, `Expected /nextrace to succeed, logs: ${JSON.stringify(nextRace.logs)}`);
    assert.ok(nextRace.logs.some((msg) => msg.includes('racing:nextrace') && msg.includes('playerBets=Arlene:100')), `Expected canonical racer field in output, got: ${JSON.stringify(nextRace.logs)}`);
  });

  it('serializes concurrent race bets without dropping paid wagers', async () => {
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[1].playerId,
      { currency: 100 },
    );

    const results = await triggerCommandsConcurrently([
      { playerId: ctx.players[0].playerId, command: 'racebet Chuck 75' },
      { playerId: ctx.players[1].playerId, command: 'racebet Biker 50' },
    ]);

    assert.ok(results.some((result) => result.success), `Expected at least one concurrent bet to succeed, got: ${JSON.stringify(results)}`);
    assert.equal(
      results.filter((result) => !result.success).every((result) => result.logs.some((msg) => msg.includes('Race state is busy'))),
      true,
      `Expected any rejected overlapping bet to fail before mutating state, got: ${JSON.stringify(results)}`,
    );
    const state = await getRaceState();
    const player0Bet = state.bets.find((bet) => bet.playerId === ctx.players[0].playerId);
    const player1Bet = state.bets.find((bet) => bet.playerId === ctx.players[1].playerId);
    const player0Succeeded = results.some((result) => result.logs.some((msg) => msg.includes('racer=Chuck') && msg.includes('amount=75')));
    const player1Succeeded = results.some((result) => result.logs.some((msg) => msg.includes('racer=Biker') && msg.includes('amount=50')));

    assert.ok(player0Bet, `Expected player 0 to retain a wager, got: ${JSON.stringify(state.bets)}`);
    assert.equal(player0Bet.racer, player0Succeeded ? 'Chuck' : 'Arlene', `Expected player 0 state to match successful replacement result, got: ${JSON.stringify(state.bets)}`);
    assert.equal(player0Bet.amount, player0Succeeded ? 75 : 100, `Expected player 0 amount to match successful replacement result, got: ${JSON.stringify(state.bets)}`);
    if (player1Succeeded) {
      assert.ok(player1Bet, `Expected player 1 successful wager to remain in race state, got: ${JSON.stringify(state.bets)}`);
      assert.equal(player1Bet.racer, 'Biker');
      assert.equal(player1Bet.amount, 50);
    } else {
      assert.equal(player1Bet, undefined, `Expected rejected player 1 wager not to be persisted, got: ${JSON.stringify(state.bets)}`);
    }
  });

  it('scheduled cronjob starts a race and delayed hook finishes it', async () => {
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 25 },
    );
    const preRaceBet = await triggerCommand(ctx.players[0].playerId, 'racebet Biker 25');
    assert.equal(preRaceBet.success, true, `Expected pre-race bet to succeed, logs: ${JSON.stringify(preRaceBet.logs)}`);

    const startHookWindow = new Date();
    const race = await triggerStartRace();
    assert.equal(race.success, true, `Expected startRace to succeed, logs: ${JSON.stringify(race.logs)}`);
    assert.ok(race.logs.some((msg) => msg.includes('racing:startRace')), `Expected startRace log, got: ${JSON.stringify(race.logs)}`);

    const runningState = await getRaceState();
    assert.equal(runningState.status, 'running', `Expected race to be running after start, got: ${JSON.stringify(runningState)}`);
    assert.ok(runningState.finishAt && runningState.finishAt >= runningState.startedAt!, `Expected finishAt in running state, got: ${JSON.stringify(runningState)}`);
    assert.equal(runningState.raceCommentary?.length, 3, `Expected three planned commentary updates, got: ${JSON.stringify(runningState)}`);
    assert.ok(runningState.plannedResults?.length, `Expected planned finishing order to be frozen at start, got: ${JSON.stringify(runningState)}`);

    const runningBet = await triggerCommand(ctx.players[0].playerId, 'racebet Biker 25');
    assert.equal(runningBet.success, false, 'Expected /racebet to reject while running');
    assert.ok(runningBet.logs.some((msg) => msg.includes('Betting is closed')), `Expected betting closed error, got: ${JSON.stringify(runningBet.logs)}`);

    const runningNextRace = await triggerCommand(ctx.players[0].playerId, 'nextrace');
    assert.equal(runningNextRace.success, true, `Expected /nextrace during running to succeed, logs: ${JSON.stringify(runningNextRace.logs)}`);
    assert.ok(runningNextRace.logs.some((msg) => msg.includes('status=running')), `Expected running nextrace log, got: ${JSON.stringify(runningNextRace.logs)}`);

    const finish = await waitForHookExecution(startHookWindow, 'racing:finishRace');
    assert.equal(finish.success, true, `Expected delayed finish hook to succeed, logs: ${JSON.stringify(finish.logs)}`);

    const lastRace = await triggerCommand(ctx.players[0].playerId, 'lastrace');
    assert.equal(lastRace.success, true, `Expected /lastrace to succeed, logs: ${JSON.stringify(lastRace.logs)}`);
    assert.ok(
      lastRace.logs.some((msg) => msg.includes('racing:lastrace') && (msg.includes('totalBets=1') || msg.includes('totalBets=2'))),
      `Expected full bet count in last race, got: ${JSON.stringify(lastRace.logs)}`,
    );

    const myBets = await triggerCommand(ctx.players[0].playerId, 'myracebets');
    assert.equal(myBets.success, true, `Expected /myracebets after race to succeed, logs: ${JSON.stringify(myBets.logs)}`);
    assert.ok(myBets.logs.some((msg) => msg.includes('racing:myracebets') && msg.includes('bets=0')), `Expected bets to be cleared, got: ${JSON.stringify(myBets.logs)}`);

    const stats = await triggerCommand(ctx.players[0].playerId, 'racestats');
    assert.equal(stats.success, true, `Expected /racestats to succeed, logs: ${JSON.stringify(stats.logs)}`);
    assert.ok(stats.logs.some((msg) => msg.includes('racing:racestats') && msg.includes('bets=1')), `Expected stats to record bet, got: ${JSON.stringify(stats.logs)}`);

    const leaderboard = await triggerCommand(ctx.players[0].playerId, 'raceleaderboard');
    assert.equal(leaderboard.success, true, `Expected /raceleaderboard to succeed, logs: ${JSON.stringify(leaderboard.logs)}`);
    assert.ok(leaderboard.logs.some((msg) => msg.includes('leaderboard')), `Expected leaderboard output, got: ${JSON.stringify(leaderboard.logs)}`);
  });

  it('admin command starts a no-bet race and delayed hook completes it', async () => {
    const hookWindow = new Date();
    const result = await triggerCommand(ctx.players[0].playerId, 'startrace');

    assert.equal(result.success, true, `Expected no-bet /startrace to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('racing:startrace') && msg.includes('status=running')), `Expected no-bet start output, got: ${JSON.stringify(result.logs)}`);
    const runningState = await getRaceState();
    assert.equal(runningState.status, 'running', `Expected manual race to be running, got: ${JSON.stringify(runningState)}`);

    const finish = await waitForHookExecution(hookWindow, 'racing:finishRace');
    assert.equal(finish.success, true, `Expected delayed manual finish hook to succeed, logs: ${JSON.stringify(finish.logs)}`);
    const completedState = await getRaceState();
    assert.equal(completedState.status, 'betting', `Expected race to return to betting after finish, got: ${JSON.stringify(completedState)}`);
    assert.equal(completedState.lastRaceResults?.totalBets, 0, `Expected no-bet result, got: ${JSON.stringify(completedState.lastRaceResults)}`);
  });

  it('broadcasts configurable race commentary during a manual race', async () => {
    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        entrants: ['Solo; 2', 'Chaser; 2', 'Rival; 2'],
        minBet: 10,
        maxBet: 100,
        commentaryEarlyTemplates: ['CUSTOM EARLY {leader} sees {winner} coming.'],
        commentaryMiddleTemplates: ['CUSTOM MIDDLE {winner} is catching {leader}.'],
        commentaryLateTemplates: ['CUSTOM LATE {winner} overtakes {leader}.'],
      },
      systemConfig: {
        hooks: {
          raceCommentaryEarlyAfterManualStart: { delay: 10 },
          raceCommentaryMiddleAfterManualStart: { delay: 15 },
          raceCommentaryLateAfterManualStart: { delay: 20 },
          finishRaceAfterManualStart: { delay: 30 },
        },
      },
    });

    const hookWindow = new Date();
    const start = await triggerCommand(ctx.players[0].playerId, 'startrace');
    assert.equal(start.success, true, `Expected /startrace to succeed, logs: ${JSON.stringify(start.logs)}`);

    const commentary = await waitForHookExecution(hookWindow, 'CUSTOM EARLY');
    assert.equal(commentary.success, true, `Expected custom commentary hook to succeed, logs: ${JSON.stringify(commentary.logs)}`);
    assert.ok(
      commentary.logs.some((msg) => msg.includes('racing:commentary') && msg.includes('CUSTOM EARLY')),
      `Expected custom commentary log, got: ${JSON.stringify(commentary.logs)}`,
    );

    const finish = await waitForHookExecution(hookWindow, 'racing:finishRace');
    assert.equal(finish.success, true, `Expected delayed finish after custom commentary to succeed, logs: ${JSON.stringify(finish.logs)}`);
  });

  it('does not double-pay when duplicate finish executions run', async () => {
    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        entrants: ['Solo; 2'],
        minBet: 10,
        maxBet: 100,
      },
      systemConfig: {
        hooks: {
          finishRaceAfterScheduledStart: { delay: 10 },
          finishRaceAfterManualStart: { delay: 10 },
        },
      },
    });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 100 },
    );

    const bet = await triggerCommand(ctx.players[0].playerId, 'racebet Solo 50');
    assert.equal(bet.success, true, `Expected single-racer bet to succeed, logs: ${JSON.stringify(bet.logs)}`);
    const beforeFinishCurrency = await getCurrency(ctx.players[0].playerId);
    const pendingState = await getRaceState();
    const runningState: RaceState = {
      ...pendingState,
      status: 'running',
      startedAt: Date.now() - 2000,
      finishAt: Date.now() - 1000,
      startRunId: `test:${pendingState.raceNumber}:${Date.now()}`,
      frozenEntrants: [{ name: 'Solo', odds: 2 }],
      frozenBets: pendingState.bets.map((stateBet) => ({ ...stateBet })),
      completion: null,
    };
    await setRaceState({
      ...runningState,
      finishAt: Date.now() - 1000,
    });

    const recovery = await triggerRecoverRunningRace();
    assert.equal(
      recovery.success || recovery.logs.some((msg) => msg.includes('completion is still in progress')),
      true,
      `Expected first finish execution to succeed or already be in progress, logs: ${JSON.stringify(recovery.logs)}`,
    );
    await waitUntil(async () => (await getCurrency(ctx.players[0].playerId)) === beforeFinishCurrency + 100, 'first duplicate-test payout');
    const afterRecoveryCurrency = await getCurrency(ctx.players[0].playerId);
    assert.equal(afterRecoveryCurrency, beforeFinishCurrency + 100, 'Expected first finish execution to pay the winning bet once');

    const duplicate = await triggerRecoverRunningRace();
    assert.equal(
      duplicate.success || duplicate.logs.some((msg) => msg.includes('completion is still in progress')),
      true,
      `Expected duplicate finish execution to succeed or report in-progress completion, logs: ${JSON.stringify(duplicate.logs)}`,
    );

    const afterFinishCurrency = await getCurrency(ctx.players[0].playerId);
    assert.equal(afterFinishCurrency, beforeFinishCurrency + 100, 'Expected exactly one winning payout after duplicate finish executions');

    const statsAfterDuplicate = await getPlayerStats(ctx.players[0].playerId);
    assert.equal(statsAfterDuplicate?.processedStatIds?.filter((id) => id === `${runningState.raceNumber}:${ctx.players[0].playerId}`).length, 1, `Expected one processed stat id for the duplicate-finish race, got: ${JSON.stringify(statsAfterDuplicate)}`);
  });

  it('recovers stranded payout-pending race completion without double-paying', async () => {
    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        entrants: ['Solo; 2'],
        minBet: 10,
        maxBet: 100,
      },
    });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 50 },
    );

    const bet = await triggerCommand(ctx.players[0].playerId, 'racebet Solo 50');
    assert.equal(bet.success, true, `Expected single-racer bet to succeed, logs: ${JSON.stringify(bet.logs)}`);
    const beforeRecoveryCurrency = await getCurrency(ctx.players[0].playerId);
    const pendingState = await getRaceState();
    const result: RaceResult = {
      raceNumber: pendingState.raceNumber,
      results: [{ name: 'Solo', odds: 2, position: 1 }],
      winner: 'Solo',
      bets: pendingState.bets,
      winners: pendingState.bets.map((pendingBet) => ({ ...pendingBet, payout: pendingBet.amount * pendingBet.odds })),
      totalBets: pendingState.bets.length,
      totalWagered: pendingState.bets.reduce((sum, pendingBet) => sum + pendingBet.amount, 0),
      totalPayout: pendingState.bets.reduce((sum, pendingBet) => sum + (pendingBet.amount * pendingBet.odds), 0),
      jackpot: 0,
      timestamp: Date.now(),
    };
    const nextRaceData: RaceState = {
      nextRaceTime: Date.now() + (2 * 60 * 60 * 1000),
      bets: [],
      lastRaceResults: result,
      raceNumber: pendingState.raceNumber + 1,
    };
    await setRaceState({
      ...pendingState,
      completion: {
        raceNumber: pendingState.raceNumber,
        status: 'payout-pending',
        result,
        nextRaceData,
      },
    });

    const recovery = await triggerRecoverRunningRace();
    assert.equal(
      recovery.success || recovery.logs.some((msg) => msg.includes('completion is still in progress')),
      true,
      `Expected retry of pending completion to succeed or already be in progress, logs: ${JSON.stringify(recovery.logs)}`,
    );
    await waitUntil(async () => (await getCurrency(ctx.players[0].playerId)) === beforeRecoveryCurrency + 100, 'recovered winner payout');
    const afterRecoveryCurrency = await getCurrency(ctx.players[0].playerId);
    assert.equal(afterRecoveryCurrency, beforeRecoveryCurrency + 100, 'Expected retry to pay the stranded winner exactly once');

    await waitUntil(async () => (await getRaceState()).raceNumber === pendingState.raceNumber + 1, 'recovered race advancement');
    const completedState = await getRaceState();
    assert.equal(completedState.raceNumber, pendingState.raceNumber + 1, `Expected race to advance after recovery, got: ${JSON.stringify(completedState)}`);
    assert.equal(completedState.lastRaceResults?.raceNumber, pendingState.raceNumber, `Expected recovered result to become last race, got: ${JSON.stringify(completedState.lastRaceResults)}`);

    const duplicate = await triggerRecoverRunningRace();
    assert.equal(duplicate.success, true, `Expected duplicate completion after recovery to succeed, logs: ${JSON.stringify(duplicate.logs)}`);
    const afterDuplicateCurrency = await getCurrency(ctx.players[0].playerId);
    assert.equal(afterDuplicateCurrency, afterRecoveryCurrency, 'Expected duplicate completion not to pay the recovered winner again');
  });

  it('does not update stats twice when recovering after stats were written before finalization', async () => {
    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        entrants: ['Solo; 2', 'Other; 2'],
        minBet: 10,
        maxBet: 100,
      },
    });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 50 },
    );

    const bet = await triggerCommand(ctx.players[0].playerId, 'racebet Solo 50');
    assert.equal(bet.success, true, `Expected bet to succeed, logs: ${JSON.stringify(bet.logs)}`);
    const pendingState = await getRaceState();
    const [pendingBet] = pendingState.bets;
    assert.ok(pendingBet, `Expected pending bet in race state, got: ${JSON.stringify(pendingState)}`);
    const result: RaceResult = {
      raceNumber: pendingState.raceNumber,
      results: [
        { name: 'Other', odds: 2, position: 1 },
        { name: 'Solo', odds: 2, position: 2 },
      ],
      winner: 'Other',
      bets: pendingState.bets,
      winners: [],
      totalBets: pendingState.bets.length,
      totalWagered: pendingState.bets.reduce((sum, stateBet) => sum + stateBet.amount, 0),
      totalPayout: 0,
      jackpot: 0,
      timestamp: Date.now(),
    };
    const nextRaceData: RaceState = {
      nextRaceTime: Date.now() + (2 * 60 * 60 * 1000),
      bets: [],
      lastRaceResults: result,
      raceNumber: pendingState.raceNumber + 1,
    };
    const statUpdateId = `${pendingState.raceNumber}:${pendingBet.playerId}`;
    const existingStats = await getPlayerStats(pendingBet.playerId);
    const statsAfterCrash: PlayerRaceStats = {
      playerName: pendingBet.playerName,
      totalWinnings: existingStats?.totalWinnings ?? 0,
      totalBets: (existingStats?.totalBets ?? 0) + 1,
      totalWagered: (existingStats?.totalWagered ?? 0) + pendingBet.amount,
      wins: existingStats?.wins ?? 0,
      losses: (existingStats?.losses ?? 0) + 1,
      biggestWin: existingStats?.biggestWin ?? 0,
      favoriteRacer: pendingBet.racer,
      racerStats: {
        ...(existingStats?.racerStats ?? {}),
        [pendingBet.racer]: {
          bets: ((existingStats?.racerStats ?? {})[pendingBet.racer]?.bets ?? 0) + 1,
          wins: (existingStats?.racerStats ?? {})[pendingBet.racer]?.wins ?? 0,
          totalWagered: ((existingStats?.racerStats ?? {})[pendingBet.racer]?.totalWagered ?? 0) + pendingBet.amount,
        },
      },
      processedStatIds: [...(existingStats?.processedStatIds ?? []), statUpdateId],
    };
    await setPlayerStats(pendingBet.playerId, statsAfterCrash);
    await setRaceState({
      ...pendingState,
      completion: {
        raceNumber: pendingState.raceNumber,
        status: 'payout-pending',
        result,
        nextRaceData,
      },
    });

    const recovery = await triggerRecoverRunningRace();
    assert.equal(
      recovery.success || recovery.logs.some((msg) => msg.includes('completion is still in progress')),
      true,
      `Expected stats recovery to succeed or already be in progress, logs: ${JSON.stringify(recovery.logs)}`,
    );
    await waitUntil(async () => {
      const state = await getRaceState();
      return state.raceNumber === pendingState.raceNumber + 1;
    }, 'stats recovery finalization');
    const recoveredStats = await getPlayerStats(pendingBet.playerId);
    assert.equal(recoveredStats?.totalBets, statsAfterCrash.totalBets, `Expected recovery not to count stats twice, got: ${JSON.stringify(recoveredStats)}`);
    assert.equal(recoveredStats?.losses, statsAfterCrash.losses, `Expected recovery not to duplicate loss stats, got: ${JSON.stringify(recoveredStats)}`);
    const completedState = await getRaceState();
    assert.ok(completedState.completion?.statsUpdatedPlayerIds?.includes(pendingBet.playerId), `Expected completion journal to record stats update, got: ${JSON.stringify(completedState.completion)}`);
    assert.ok(completedState.completion?.finalizedPlayerIds?.includes(pendingBet.playerId), `Expected completion journal to finalize player, got: ${JSON.stringify(completedState.completion)}`);
  });

  it('does not resume an active long-running completion after the outer lock expires', async () => {
    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        entrants: ['Solo; 2'],
        minBet: 10,
        maxBet: 100,
      },
    });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 50 },
    );

    const bet = await triggerCommand(ctx.players[0].playerId, 'racebet Solo 50');
    assert.equal(bet.success, true, `Expected single-racer bet to succeed, logs: ${JSON.stringify(bet.logs)}`);
    const beforeRetryCurrency = await getCurrency(ctx.players[0].playerId);
    const pendingState = await getRaceState();
    const result: RaceResult = {
      raceNumber: pendingState.raceNumber,
      results: [{ name: 'Solo', odds: 2, position: 1 }],
      winner: 'Solo',
      bets: pendingState.bets,
      winners: pendingState.bets.map((pendingBet) => ({ ...pendingBet, payout: pendingBet.amount * pendingBet.odds })),
      totalBets: pendingState.bets.length,
      totalWagered: pendingState.bets.reduce((sum, pendingBet) => sum + pendingBet.amount, 0),
      totalPayout: pendingState.bets.reduce((sum, pendingBet) => sum + (pendingBet.amount * pendingBet.odds), 0),
      jackpot: 0,
      timestamp: Date.now(),
    };
    const nextRaceData: RaceState = {
      nextRaceTime: Date.now() + (2 * 60 * 60 * 1000),
      bets: [],
      lastRaceResults: result,
      raceNumber: pendingState.raceNumber + 1,
    };
    await setRaceState({
      ...pendingState,
      completion: {
        raceNumber: pendingState.raceNumber,
        status: 'payout-pending',
        result,
        nextRaceData,
        activeOwner: 'still-running-completion',
        activeExpiresAt: Date.now() + (5 * 60 * 1000),
      },
    });
    await createStaleRaceLock('expired-outer-lock');

    const activeRetry = await triggerRecoverRunningRace();
    assert.equal(activeRetry.success, false, `Expected active completion retry to report busy, logs: ${JSON.stringify(activeRetry.logs)}`);
    assert.ok(activeRetry.logs.some((msg) => msg.includes('completion is still in progress')), `Expected busy completion output, got: ${JSON.stringify(activeRetry.logs)}`);
    const afterActiveRetryCurrency = await getCurrency(ctx.players[0].playerId);
    assert.equal(afterActiveRetryCurrency, beforeRetryCurrency, 'Expected active completion retry not to pay while another invocation is still leased');
    const stillPendingState = await getRaceState();
    assert.equal(stillPendingState.raceNumber, pendingState.raceNumber, `Expected active completion to remain pending, got: ${JSON.stringify(stillPendingState)}`);
    assert.equal(stillPendingState.completion?.finalizedPlayerIds?.length ?? 0, 0, `Expected no finalized players during active retry, got: ${JSON.stringify(stillPendingState.completion)}`);

    await setRaceState({
      ...stillPendingState,
      completion: {
        ...stillPendingState.completion!,
        activeExpiresAt: Date.now() - 1000,
      },
    });

    const expiredRetry = await triggerRecoverRunningRace();
    assert.equal(
      expiredRetry.success || expiredRetry.logs.some((msg) => msg.includes('completion is still in progress')),
      true,
      `Expected expired completion lease retry to succeed or already be in progress, logs: ${JSON.stringify(expiredRetry.logs)}`,
    );
    await waitUntil(async () => (await getCurrency(ctx.players[0].playerId)) === beforeRetryCurrency + 100, 'expired active lease payout');
    const afterExpiredRetryCurrency = await getCurrency(ctx.players[0].playerId);
    assert.equal(afterExpiredRetryCurrency, beforeRetryCurrency + 100, 'Expected expired active lease to allow normal pending payout recovery exactly once');
    await waitUntil(async () => (await getRaceState()).raceNumber === pendingState.raceNumber + 1, 'expired active lease race advancement');
    const completedState = await getRaceState();
    assert.equal(completedState.raceNumber, pendingState.raceNumber + 1, `Expected expired lease retry to advance race, got: ${JSON.stringify(completedState)}`);
  });

  it('uses custom horse-themed labels and entrants', async () => {
    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        racerTypeLabel: 'horse',
        racerTypePluralLabel: 'horses',
        raceName: 'Derby',
        entrants: ['Comet; 2', 'Storm; 4'],
        minBet: 10,
        maxBet: 100,
      },
    });

    const result = await triggerCommand(ctx.players[0].playerId, 'racers');
    assert.equal(result.success, true, `Expected /racers to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('Derby')), `Expected custom race name, got: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('label=horses')), `Expected custom plural label, got: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('Comet:2')), `Expected custom entrant, got: ${JSON.stringify(result.logs)}`);

    await uninstallModule(client, moduleId, ctx.gameServer.id);
  });

  it('falls back to legacy Horses config when entrants is absent', async () => {
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        racerTypeLabel: 'horse',
        racerTypePluralLabel: 'horses',
        raceName: 'Legacy Derby',
        Horses: ['LegacyComet; 3', 'LegacyBolt; 5'],
        minBet: 10,
        maxBet: 100,
      },
    });

    const result = await triggerCommand(ctx.players[0].playerId, 'racers');
    assert.equal(result.success, true, `Expected /racers to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('LegacyComet:3')), `Expected legacy Horses entrant, got: ${JSON.stringify(result.logs)}`);

    await uninstallModule(client, moduleId, ctx.gameServer.id);
  });

  it('falls back to legacy Zombies config when entrants is absent', async () => {
    await installRacingModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        raceName: 'Legacy Zombie Race',
        Zombies: ['LegacyBiter; 2', 'LegacyCrawler; 6'],
        minBet: 10,
        maxBet: 100,
      },
    });

    const result = await triggerCommand(ctx.players[0].playerId, 'racers');
    assert.equal(result.success, true, `Expected /racers to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((msg) => msg.includes('LegacyBiter:2')), `Expected legacy Zombies entrant, got: ${JSON.stringify(result.logs)}`);
  });
});
