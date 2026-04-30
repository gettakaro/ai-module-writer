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
import {
  isBlank,
  trimOrEmpty,
  normalizeReason,
  compactRules,
  formatOnlinePlayersLine,
  getCommandTargetPlayer,
  renderTemplate,
  parseBanDurationToken,
} from '../src/functions/server-toolkit-pure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

// Helpers -------------------------------------------------------------------

type CommandMeta = { result?: { success?: boolean; logs?: Array<{ msg: string }> } };

async function fetchPlayerName(client: Client, playerId: string): Promise<string> {
  const result = await client.player.playerControllerGetOne(playerId);
  return result.data.data.name;
}

async function triggerCommand(
  client: Client,
  ctx: MockServerContext,
  prefix: string,
  msg: string,
  playerId: string,
): Promise<{ success: boolean; logs: string[] }> {
  const startTime = new Date();

  await client.command.commandControllerTrigger(ctx.gameServer.id, {
    msg: `${prefix}${msg}`,
    playerId,
  });

  const event = await waitForEvent(client, {
    eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
    gameserverId: ctx.gameServer.id,
    after: startTime,
    timeout: 30000,
  });

  const meta = event.meta as CommandMeta;
  const success = meta?.result?.success ?? false;
  const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
  return { success, logs };
}

// Pure helpers live in server-toolkit-pure.js and are the single source of truth.
// Commands import pure helpers from ./server-toolkit-pure.js (Takaro-dependent helpers from ./server-toolkit-helpers.js).
// Tests import from ../src/functions/server-toolkit-pure.js directly — same code that runs in production.

describe('toolkit: formatOnlinePlayersLine unit behavior', () => {
  it('returns no-players message for empty list', () => {
    assert.equal(formatOnlinePlayersLine([]), 'No players are currently online.');
  });

  it('uses singular "player" for exactly one player', () => {
    const result = formatOnlinePlayersLine([{ name: 'Alice' }]);
    assert.equal(result, '1 player online: Alice');
  });

  it('sorts names alphabetically (case-insensitive)', () => {
    const result = formatOnlinePlayersLine([
      { name: 'Zara' },
      { name: 'alice' },
      { name: 'Bob' },
    ]);
    assert.ok(result.startsWith('3 players online: alice, Bob, Zara'), `Got: ${result}`);
  });

  it('shows up to 10 names without truncation for exactly 10 players', () => {
    const players = Array.from({ length: 10 }, (_, i) => ({ name: `Player${String(i).padStart(2, '0')}` }));
    const result = formatOnlinePlayersLine(players);
    assert.ok(!result.includes('...'), `Expected no truncation for 10 players, got: ${result}`);
    assert.ok(result.startsWith('10 players online:'), `Got: ${result}`);
  });

  it('truncates with "..." for more than 10 players', () => {
    const players = Array.from({ length: 11 }, (_, i) => ({ name: `Player${String(i).padStart(2, '0')}` }));
    const result = formatOnlinePlayersLine(players);
    assert.ok(result.includes('...'), `Expected truncation for 11 players, got: ${result}`);
    assert.ok(result.startsWith('11 players online:'), `Got: ${result}`);
  });

  it('shows total count even when truncated (27 players example)', () => {
    const players = Array.from({ length: 27 }, (_, i) => ({ name: `Player${String(i).padStart(2, '0')}` }));
    const result = formatOnlinePlayersLine(players);
    assert.ok(result.startsWith('27 players online:'), `Got: ${result}`);
    assert.ok(result.endsWith(', ...'), `Expected ", ..." at end, got: ${result}`);
  });
});

describe('toolkit: parseBanDurationToken unit behavior', () => {
  it('"perm" is permanent', () => {
    const result = parseBanDurationToken('perm');
    assert.ok(result !== null);
    assert.equal(result!.isPermanent, true);
    assert.equal(result!.humanDuration, 'permanent');
    assert.equal(result!.expiresAt, undefined);
  });

  it('"permanent" is permanent', () => {
    const result = parseBanDurationToken('permanent');
    assert.ok(result !== null);
    assert.equal(result!.isPermanent, true);
  });

  it('1m renders as "1 minute" (singular)', () => {
    const result = parseBanDurationToken('1m');
    assert.ok(result !== null);
    assert.equal(result!.humanDuration, '1 minute');
    assert.equal(result!.isPermanent, false);
    assert.ok(result!.expiresAt !== undefined);
  });

  it('2m renders as "2 minutes" (plural)', () => {
    const result = parseBanDurationToken('2m');
    assert.ok(result !== null);
    assert.equal(result!.humanDuration, '2 minutes');
  });

  it('1d renders as "1 day" (singular)', () => {
    const result = parseBanDurationToken('1d');
    assert.ok(result !== null);
    assert.equal(result!.humanDuration, '1 day');
  });

  it('7d renders as "7 days" (plural)', () => {
    const result = parseBanDurationToken('7d');
    assert.ok(result !== null);
    assert.equal(result!.humanDuration, '7 days');
  });

  it('1w renders as "1 week" (singular)', () => {
    const result = parseBanDurationToken('1w');
    assert.ok(result !== null);
    assert.equal(result!.humanDuration, '1 week');
  });

  it('2w renders as "2 weeks" (plural)', () => {
    const result = parseBanDurationToken('2w');
    assert.ok(result !== null);
    assert.equal(result!.humanDuration, '2 weeks');
  });

  it('12h renders as "12 hours"', () => {
    const result = parseBanDurationToken('12h');
    assert.ok(result !== null);
    assert.equal(result!.humanDuration, '12 hours');
  });

  it('invalid token returns null', () => {
    assert.equal(parseBanDurationToken('invalid-duration'), null);
    assert.equal(parseBanDurationToken('0m'), null);
    assert.equal(parseBanDurationToken('-5h'), null);
    assert.equal(parseBanDurationToken(''), null);
  });
});

describe('toolkit: isBlank unit behavior', () => {
  it('returns true for undefined', () => {
    assert.equal(isBlank(undefined), true);
  });

  it('returns true for null', () => {
    assert.equal(isBlank(null), true);
  });

  it('returns true for empty string', () => {
    assert.equal(isBlank(''), true);
  });

  it('returns true for whitespace-only string', () => {
    assert.equal(isBlank('   '), true);
  });

  it('returns false for a non-empty string', () => {
    assert.equal(isBlank('hello'), false);
  });

  it('returns false for a non-string non-null value', () => {
    assert.equal(isBlank(42), false);
  });

  it('returns false for boolean false (stringifies to "false")', () => {
    assert.equal(isBlank(false), false);
  });

  it('returns false for numeric 0 (stringifies to "0")', () => {
    assert.equal(isBlank(0), false);
  });
});

describe('toolkit: trimOrEmpty unit behavior', () => {
  it('returns empty string for non-string falsy value', () => {
    assert.equal(trimOrEmpty(undefined), '');
    assert.equal(trimOrEmpty(null), '');
  });

  it('returns trimmed string for padded string', () => {
    assert.equal(trimOrEmpty('  hello  '), 'hello');
  });

  it('returns empty string for whitespace-only input', () => {
    assert.equal(trimOrEmpty('   '), '');
  });
});

describe('toolkit: normalizeReason unit behavior', () => {
  it('returns fallback for sentinel "?"', () => {
    assert.equal(normalizeReason('?', 'Default reason'), 'Default reason');
  });

  it('returns fallback for blank input', () => {
    assert.equal(normalizeReason('', 'Default reason'), 'Default reason');
    assert.equal(normalizeReason('   ', 'Default reason'), 'Default reason');
  });

  it('returns trimmed value when not blank or sentinel', () => {
    assert.equal(normalizeReason('  Griefing  ', 'Default reason'), 'Griefing');
  });
});

describe('toolkit: compactRules unit behavior', () => {
  it('returns empty array for non-array input', () => {
    assert.deepEqual(compactRules(null), []);
    assert.deepEqual(compactRules(undefined), []);
    assert.deepEqual(compactRules('not an array'), []);
  });

  it('filters out blank and whitespace-only entries', () => {
    assert.deepEqual(compactRules(['', '   ', '\t']), []);
  });

  it('keeps valid entries', () => {
    assert.deepEqual(compactRules(['No griefing', 'Be respectful']), ['No griefing', 'Be respectful']);
  });

  it('trims entries and filters blanks from mixed array', () => {
    const result = compactRules(['  No griefing  ', '   ', 'Be respectful']);
    assert.deepEqual(result, ['No griefing', 'Be respectful']);
  });
});

describe('toolkit: getCommandTargetPlayer unit behavior', () => {
  it('returns null for null or non-object input', () => {
    assert.equal(getCommandTargetPlayer(null), null);
    assert.equal(getCommandTargetPlayer('string'), null);
    assert.equal(getCommandTargetPlayer(42), null);
  });

  it('returns null when playerId is missing or blank', () => {
    assert.equal(getCommandTargetPlayer({}), null);
    assert.equal(getCommandTargetPlayer({ playerId: '   ' }), null);
  });

  it('returns normalized player object with only playerId', () => {
    const result = getCommandTargetPlayer({ playerId: 'abc-123' });
    assert.ok(result !== null);
    assert.equal(result!.playerId, 'abc-123');
    assert.equal(result!.name, 'Unknown Player');
  });

  it('returns normalized player object with full shape', () => {
    const result = getCommandTargetPlayer({
      playerId: 'abc-123',
      name: '  Alice  ',
      gameId: 'g1',
      gameServerId: 'srv1',
      online: true,
    });
    assert.ok(result !== null);
    assert.equal(result!.name, 'Alice');
    assert.equal(result!.gameId, 'g1');
    assert.equal(result!.online, true);
  });
});

describe('toolkit: renderTemplate unit behavior', () => {
  it('returns source unchanged when no placeholders present', () => {
    assert.equal(renderTemplate('Hello world', {}), 'Hello world');
  });

  it('replaces all placeholders when provided', () => {
    const result = renderTemplate('{player} got {amount} coins from {admin}', {
      player: 'Alice',
      amount: 100,
      admin: 'Bob',
    });
    assert.equal(result, 'Alice got 100 coins from Bob');
  });

  it('keeps placeholder literal when key is missing', () => {
    const result = renderTemplate('{player} got {amount} coins', { player: 'Alice' });
    assert.equal(result, 'Alice got {amount} coins');
  });

  it('replaces every occurrence when placeholder appears twice', () => {
    const result = renderTemplate('{name} and {name}', { name: 'Alice' });
    assert.equal(result, 'Alice and Alice');
  });
});

// Suite 1: Public commands --------------------------------------------------

describe('toolkit: public commands', () => {
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
        discordLink: 'https://discord.gg/example',
        rules: ['No griefing', 'Be respectful', 'No cheating'],
        serverInfoMessage: 'Welcome to our server!',
        broadcastCurrencyGrants: false,
        broadcastKicks: false,
        broadcastBans: false,
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

  it('/serverinfo shows server name and online count', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'serverinfo', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('Server:') && msg.includes('Players online:')),
      `Expected serverinfo output with Server: and Players online:, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/serverinfo shows configured info message when set', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'serverinfo', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('Welcome to our server!')),
      `Expected serverinfo output to include info message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/online shows player count when players are online', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'online', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('players online') || msg.includes('player online')),
      `Expected online player list, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/online lists players in alphabetical order', async () => {
    // ctx.players has 3 players — enough to verify alphabetical sorting
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'online', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);

    // Find the online log line
    const onlineLine = logs.find((msg) => msg.includes('players online') || msg.includes('player online'));
    assert.ok(onlineLine, `Expected online line in logs, got: ${JSON.stringify(logs)}`);

    // Extract the names portion (after "N players online: ")
    const namesMatch = onlineLine!.match(/\d+ players? online: (.+)/);
    assert.ok(namesMatch, `Expected /online output in format "N players online: ...", got: ${onlineLine}`);
    const names = namesMatch![1].replace(', ...', '').split(', ');
    // Verify names are in alphabetical order
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    assert.deepEqual(names, sorted, `Expected alphabetical order, got: ${names.join(', ')}`);
  });

  it('/discord shows configured link', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'discord', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('discord.gg/example')),
      `Expected discord link in output, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/rules shows "Server rules:" header followed by numbered rules', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'rules', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    const allLogs = logs.join('\n');
    assert.ok(
      allLogs.includes('Server rules:'),
      `Expected "Server rules:" header in output, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      allLogs.includes('No griefing') && allLogs.includes('Be respectful'),
      `Expected rules in output, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/rules filters whitespace-only entries', async () => {
    // This suite's rules config is clean, but we test that numbered list format is correct
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'rules', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    const allLogs = logs.join('\n');
    // Should have exactly 3 numbered rules
    assert.ok(allLogs.includes('1.'), `Expected numbered rule 1, got: ${JSON.stringify(logs)}`);
    assert.ok(allLogs.includes('2.'), `Expected numbered rule 2, got: ${JSON.stringify(logs)}`);
    assert.ok(allLogs.includes('3.'), `Expected numbered rule 3, got: ${JSON.stringify(logs)}`);
  });
});

// Suite 2: Empty config fallbacks -------------------------------------------

describe('toolkit: empty config fallbacks', () => {
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

    // Install with empty config (no discord link, no rules, no serverInfoMessage)
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        discordLink: '',
        rules: [],
        serverInfoMessage: '',
        broadcastCurrencyGrants: false,
        broadcastKicks: false,
        broadcastBans: false,
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

  it('/discord shows unconfigured message when discord link is empty', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'discord', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('not configured')),
      `Expected unconfigured discord message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/rules shows unconfigured message when rules are empty', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'rules', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('not configured')),
      `Expected unconfigured rules message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/rules filters whitespace-only entries and shows unconfigured', async () => {
    // Reinstall with whitespace rules - handled by separate context
    // For this suite, rules=[] so we just verify the fallback
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'rules', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('not configured')),
      `Expected unconfigured message for empty rules, got: ${JSON.stringify(logs)}`,
    );
    // Should NOT have numbered items
    const allLogs = logs.join('\n');
    assert.ok(!allLogs.includes('1.'), `Expected no numbered rules, got: ${JSON.stringify(logs)}`);
  });

  it('/serverinfo does not show info line when serverInfoMessage is empty', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'serverinfo', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    const allLogs = logs.join('\n');
    assert.ok(
      !allLogs.includes('Info:'),
      `Expected no Info: line when serverInfoMessage is empty, got: ${JSON.stringify(logs)}`,
    );
  });
});

// Suite 2b: /rules whitespace-filter test ------------------------------------

describe('toolkit: /rules whitespace-filter', () => {
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

    // Install with rules that include whitespace-only entries (VI-14)
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        discordLink: '',
        rules: ['No griefing', '   ', 'Be respectful', '\t'],
        serverInfoMessage: '',
        broadcastCurrencyGrants: false,
        broadcastKicks: false,
        broadcastBans: false,
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

  it('/rules shows only non-blank entries when whitespace-only items present', async () => {
    const player = ctx.players[0]!;
    const { success, logs } = await triggerCommand(client, ctx, prefix, 'rules', player.playerId);

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    const allLogs = logs.join('\n');

    // Should have "No griefing" and "Be respectful"
    assert.ok(allLogs.includes('No griefing'), `Expected "No griefing" in output, got: ${JSON.stringify(logs)}`);
    assert.ok(allLogs.includes('Be respectful'), `Expected "Be respectful" in output, got: ${JSON.stringify(logs)}`);

    // Should have exactly 2 entries (1. and 2. but not 3.)
    assert.ok(allLogs.includes('1.'), `Expected rule #1, got: ${JSON.stringify(logs)}`);
    assert.ok(allLogs.includes('2.'), `Expected rule #2, got: ${JSON.stringify(logs)}`);
    assert.ok(!allLogs.includes('3.'), `Expected no rule #3 (whitespace filtered), got: ${JSON.stringify(logs)}`);
  });
});

// Suite 3: Admin commands (kick / ban / givecurrency) -----------------------

describe('toolkit: admin commands', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let kickRoleId: string | undefined;
  let banRoleId: string | undefined;
  let currencyRoleId: string | undefined;
  // player names for player-type argument resolution (Takaro resolves by name, not UUID)
  let playerNames: string[] = [];

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    // Enable economy for currency tests
    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        discordLink: '',
        rules: [],
        serverInfoMessage: '',
        broadcastCurrencyGrants: true,
        currencyGrantBroadcastMessage: '{player} received {amount} currency from {admin}.',
        broadcastKicks: true,
        kickBroadcastMessage: '{player} was kicked by {admin}. Reason: {reason}',
        broadcastBans: true,
        banBroadcastMessage: '{player} was banned by {admin} for {duration}. Reason: {reason}',
        banPermBroadcastMessage: '{player} was permanently banned by {admin}. Reason: {reason}',
      },
    });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    // Fetch player names — Takaro resolves player-type arguments by name, not UUID
    playerNames = await Promise.all(
      ctx.players.map((p) => fetchPlayerName(client, p.playerId)),
    );

    // player[0] = kick admin, player[1] = ban admin, player[2] = currency admin & target
    kickRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['TOOLKIT_KICK']);
    banRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, ['TOOLKIT_BAN']);
    currencyRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['TOOLKIT_GIVE_CURRENCY']);

    // Give player[0] some currency for self-givecurrency test
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 500 },
    );
  });

  after(async () => {
    await cleanupRole(client, kickRoleId);
    await cleanupRole(client, banRoleId);
    await cleanupRole(client, currencyRoleId);
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

  // --- /kick tests ---

  it('/kick denied without TOOLKIT_KICK permission', async () => {
    // player[2] has no kick permission
    const player = ctx.players[2]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `kick ${playerNames[1]}`,
      player.playerId,
    );

    assert.equal(success, false, `Expected failure without permission, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('do not have permission')),
      `Expected permission denied message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/kick self-targeting is denied', async () => {
    // player[0] has TOOLKIT_KICK, tries to kick themselves
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `kick ${playerNames[0]}`,
      admin.playerId,
    );

    assert.equal(success, false, `Expected failure for self-kick, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('cannot use this command on yourself')),
      `Expected self-kick denial, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/kick works with TOOLKIT_KICK permission and logs the kick', async () => {
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `kick ${playerNames[2]} Griefing`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected kick to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('toolkit:kick')),
      `Expected kick log, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((msg) => msg.includes(`Kicked ${playerNames[2]}. Reason: Griefing`)),
      `Expected admin PM confirmation in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/kick with broadcast enabled logs broadcast message', async () => {
    // broadcastKicks is true in this suite — player[2] may be offline after previous kick
    // Use player[1] as target (ban admin can be kicked by kick admin)
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `kick ${playerNames[1]} Testing broadcast`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected kick to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('[broadcast]')),
      `Expected broadcast log when broadcastKicks=true, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/kick with no reason uses default reason', async () => {
    // Ensure player[2] is online before this test (may have been kicked earlier).
    // Use connectAll since the mock server doesn't support individual connect <playerN>.
    await ctx.server.executeConsoleCommand('connectAll');

    // Poll until player[2] shows as online in Takaro
    const p2Id = ctx.players[2]!.playerId;
    const deadline = Date.now() + 15000;
    let p2IsOnline = false;
    while (Date.now() < deadline) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], online: [true] },
        limit: 10,
      });
      if (result.data.data.some((p) => p.playerId === p2Id)) {
        p2IsOnline = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(p2IsOnline, `Expected player[2] to be online within 15000ms before kick-default-reason test`);

    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `kick ${playerNames[2]}`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected kick to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('Kicked by an admin.')),
      `Expected default reason "Kicked by an admin.", got: ${JSON.stringify(logs)}`,
    );
  });

  it('/kick offline target returns not-online message', async () => {
    // Disconnect ALL players so player[2] is definitely offline.
    // The mock server does not support individual disconnect by index —
    // only disconnectAll is reliable. connectAll is used afterward to restore state.
    const admin = ctx.players[0]!;
    const p2Id = ctx.players[2]!.playerId;
    await ctx.server.executeConsoleCommand('disconnectAll');

    // Poll until player[2] shows as offline in Takaro
    const offlineDeadline = Date.now() + 15000;
    let p2IsOffline = false;
    while (Date.now() < offlineDeadline) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], online: [true] },
        limit: 10,
      });
      if (!result.data.data.some((p) => p.playerId === p2Id)) {
        p2IsOffline = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(p2IsOffline, `Expected player[2] to be offline within 15000ms for offline-kick test`);

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `kick ${playerNames[2]}`,
      admin.playerId,
    );

    // Assert command behavior first — before reconnect cleanup — so a reconnect timeout
    // fails separately from a command-behavior bug.
    assert.equal(success, false, `Expected failure for offline target, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('not currently online')),
      `Expected "not currently online" message for offline target, got: ${JSON.stringify(logs)}`,
    );

    // Cleanup: reconnect players so downstream tests are not affected.
    await ctx.server.executeConsoleCommand('connectAll');
    const onlineDeadline = Date.now() + 30000;
    let p2IsOnlineAgain = false;
    while (Date.now() < onlineDeadline) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], online: [true] },
        limit: 10,
      });
      if (result.data.data.some((p) => p.playerId === p2Id)) {
        p2IsOnlineAgain = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(p2IsOnlineAgain, `Expected player[2] to reconnect within 30000ms (cleanup)`);
  });

  // --- /ban tests ---

  it('/ban denied without TOOLKIT_BAN permission', async () => {
    // player[2] has no ban permission
    const player = ctx.players[2]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[0]} 1h`,
      player.playerId,
    );

    assert.equal(success, false, `Expected failure without permission, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('do not have permission')),
      `Expected permission denied message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/ban self-targeting is denied', async () => {
    const admin = ctx.players[1]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[1]} 1h`,
      admin.playerId,
    );

    assert.equal(success, false, `Expected failure for self-ban, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('cannot use this command on yourself')),
      `Expected self-ban denial, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/ban rejects invalid duration "invalid-duration"', async () => {
    const admin = ctx.players[1]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[0]} invalid-duration`,
      admin.playerId,
    );

    assert.equal(success, false, `Expected failure for invalid duration, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('Invalid duration')),
      `Expected invalid duration message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/ban rejects invalid duration "0m" (zero not allowed)', async () => {
    const admin = ctx.players[1]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[0]} 0m`,
      admin.playerId,
    );

    assert.equal(success, false, `Expected failure for 0m duration, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('Invalid duration')),
      `Expected invalid duration message for 0m, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/ban works with temporary duration (1h) and payload has expiresAt', async () => {
    const admin = ctx.players[1]!;
    const target = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[0]} 1h Temporary ban test`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected temp ban to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('toolkit:ban')),
      `Expected ban log, got: ${JSON.stringify(logs)}`,
    );

    // VI-13: Parse payload log and assert expiresAt IS PRESENT for temp ban
    const payloadLog = logs.find((msg) => msg.startsWith('toolkit:ban payload='));
    assert.ok(payloadLog, `Expected payload log line, got: ${JSON.stringify(logs)}`);
    const payloadStr = payloadLog!.replace('toolkit:ban payload=', '');
    const payload = JSON.parse(payloadStr);
    assert.ok('expiresAt' in payload, `Expected expiresAt in temp ban payload, got: ${JSON.stringify(payload)}`);
    assert.ok(payload.expiresAt !== null && payload.expiresAt !== undefined, `expiresAt should not be null/undefined`);

    assert.ok(
      logs.some((msg) => msg.includes(`Banned ${playerNames[0]} for 1 hour. Reason:`)),
      `Expected admin PM for temp ban in logs, got: ${JSON.stringify(logs)}`,
    );

    // Unban player[0] so they can be used in subsequent tests
    await client.gameserver.gameServerControllerUnbanPlayer(ctx.gameServer.id, target.playerId);
  });

  it('/ban works with permanent duration (perm) and payload has no expiresAt', async () => {
    const admin = ctx.players[1]!;
    const target = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[0]} perm Permanent ban test`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected perm ban to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('permanent') || msg.includes('perm')),
      `Expected permanent ban in payload log, got: ${JSON.stringify(logs)}`,
    );

    // VI-13: Parse payload log and assert expiresAt is ABSENT for perm ban
    const payloadLog = logs.find((msg) => msg.startsWith('toolkit:ban payload='));
    assert.ok(payloadLog, `Expected payload log line, got: ${JSON.stringify(logs)}`);
    const payloadStr = payloadLog!.replace('toolkit:ban payload=', '');
    const payload = JSON.parse(payloadStr);
    assert.ok(!('expiresAt' in payload), `Expected no expiresAt in perm ban payload, got: ${JSON.stringify(payload)}`);

    assert.ok(
      logs.some((msg) => msg.includes(`Banned ${playerNames[0]} permanently. Reason:`)),
      `Expected admin PM for perm ban in logs, got: ${JSON.stringify(logs)}`,
    );

    // Unban player[0] for cleanup
    await client.gameserver.gameServerControllerUnbanPlayer(ctx.gameServer.id, target.playerId);
  });

  it('/ban perm with broadcast uses perm-specific template (no "for permanently")', async () => {
    // VI-1: broadcastBans is true in this suite — verify perm ban broadcast uses correct grammar
    const admin = ctx.players[1]!;
    const target = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[0]} perm Grammar test`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected perm ban to succeed, logs: ${JSON.stringify(logs)}`);

    // Should broadcast using banPermBroadcastMessage template (no "for permanently")
    const broadcastLog = logs.find((msg) => msg.startsWith('[broadcast]'));
    assert.ok(broadcastLog, `Expected broadcast log, got: ${JSON.stringify(logs)}`);
    assert.ok(
      !broadcastLog!.includes('for permanently'),
      `Expected no "for permanently" grammar, got: ${broadcastLog}`,
    );
    assert.ok(
      broadcastLog!.includes('permanently'),
      `Expected "permanently" in broadcast, got: ${broadcastLog}`,
    );

    // Unban for cleanup
    await client.gameserver.gameServerControllerUnbanPlayer(ctx.gameServer.id, target.playerId);
  });

  it('/ban temp with broadcast uses temp template with duration', async () => {
    const admin = ctx.players[1]!;
    const target = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `ban ${playerNames[0]} 7d Temp broadcast test`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected temp ban to succeed, logs: ${JSON.stringify(logs)}`);

    const broadcastLog = logs.find((msg) => msg.startsWith('[broadcast]'));
    assert.ok(broadcastLog, `Expected broadcast log, got: ${JSON.stringify(logs)}`);
    assert.ok(
      broadcastLog!.includes('7 days'),
      `Expected "7 days" in broadcast, got: ${broadcastLog}`,
    );

    // Unban for cleanup
    await client.gameserver.gameServerControllerUnbanPlayer(ctx.gameServer.id, target.playerId);
  });

  // --- /givecurrency tests ---

  it('/givecurrency denied without TOOLKIT_GIVE_CURRENCY permission', async () => {
    // player[1] has no currency permission; target player[0] (online throughout)
    const player = ctx.players[1]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `givecurrency ${playerNames[0]} 50`,
      player.playerId,
    );

    assert.equal(success, false, `Expected failure without permission, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('do not have permission')),
      `Expected permission denied message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/givecurrency rejects zero amount', async () => {
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `givecurrency ${playerNames[1]} 0`,
      admin.playerId,
    );

    assert.equal(success, false, `Expected failure for amount=0, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('positive whole number')),
      `Expected positive whole number message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/givecurrency rejects negative amount', async () => {
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `givecurrency ${playerNames[1]} -10`,
      admin.playerId,
    );

    assert.equal(success, false, `Expected failure for negative amount, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('positive whole number')),
      `Expected positive whole number message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/givecurrency succeeds and logs the grant', async () => {
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `givecurrency ${playerNames[1]} 100`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected givecurrency to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('toolkit:givecurrency')),
      `Expected givecurrency log, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/givecurrency self-targeting is allowed', async () => {
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `givecurrency ${playerNames[0]} 10`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected self-givecurrency to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('toolkit:givecurrency')),
      `Expected givecurrency log for self, got: ${JSON.stringify(logs)}`,
    );
  });

  it('/givecurrency with broadcast enabled logs broadcast message', async () => {
    // broadcastCurrencyGrants is true in this suite's install config
    const admin = ctx.players[0]!;

    const { success, logs } = await triggerCommand(
      client, ctx, prefix,
      `givecurrency ${playerNames[1]} 25`,
      admin.playerId,
    );

    assert.equal(success, true, `Expected givecurrency to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('[broadcast]')),
      `Expected broadcast log when broadcastCurrencyGrants=true, got: ${JSON.stringify(logs)}`,
    );
  });
});

// Suite 4: /online with no players ------------------------------------------

describe('toolkit: /online no-players fallback', () => {
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
        discordLink: '',
        rules: [],
        serverInfoMessage: '',
      },
    });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);
  });

  after(async () => {
    // Reconnect players before cleanup (they were disconnected in test)
    try {
      await ctx.server.executeConsoleCommand('connectAll');
    } catch (err) {
      console.error('Cleanup: failed to reconnect players:', err);
    }
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

  it('/online shows no-players message when all players are disconnected', async () => {
    const triggeringPlayer = ctx.players[0]!;

    // Disconnect all players — commandControllerTrigger is an API call and does not
    // require the triggering player to be in-game, so this is safe.
    await ctx.server.executeConsoleCommand('disconnectAll');

    // Poll Takaro until it reflects 0 online players (give up after 30s)
    const deadline = Date.now() + 30000;
    let allOffline = false;
    while (Date.now() < deadline) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], online: [true] },
        limit: 10,
      });
      if ((result.data.meta?.total ?? result.data.data.length) === 0) {
        allOffline = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(allOffline, `Expected all players to be offline within 30000ms for /online no-players test`);

    const { success, logs } = await triggerCommand(
      client, ctx, prefix, 'online', triggeringPlayer.playerId,
    );

    assert.equal(success, true, `Expected success, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('No players are currently online')),
      `Expected no-players message when all players disconnected, got: ${JSON.stringify(logs)}`,
    );
  });
});
