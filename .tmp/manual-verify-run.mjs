import { createClient } from '../test/helpers/client.ts';

const client = await createClient();
const gameServerId = '95473107-f960-4cd0-a15f-ede2e089e64a';
const botBase = 'http://localhost:3104';
const prefix = '+';
const adminName = 'BotAdmin';
const playerName = 'BotPlayer';
const adminUsername = 'Bot_BotAdmin';
const playerUsername = 'Bot_BotPlayer';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function botChat(bot, message) {
  const res = await fetch(`${botBase}/bot/${bot}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`bot chat failed ${res.status}: ${await res.text()}`);
}

async function findPlayerIdByName(name) {
  const res = await client.player.playerControllerSearch({ filters: { name: [name] }, limit: 10 });
  const found = res.data.data.find((p) => p.name === name);
  if (!found) throw new Error(`Player not found: ${name}`);
  return found.id;
}

async function waitForEvent(eventName, after, predicate = () => true, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.event.eventControllerSearch({
      filters: { eventName: [eventName], gameserverId: [gameServerId] },
      greaterThan: { createdAt: after.toISOString() },
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit: 20,
    });
    const found = result.data.data.find(predicate);
    if (found) return found;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${eventName}`);
}

function commandLogs(event) {
  return (event.meta?.result?.logs ?? []).map((l) => l.msg);
}

const adminPlayerId = await findPlayerIdByName(adminUsername);
const playerPlayerId = await findPlayerIdByName(playerUsername);
await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, adminPlayerId, { currency: 500 });
await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerPlayerId, { currency: 500 });

const modules = await client.module.moduleControllerSearch({ filters: { name: ['test-vote-restart'] }, limit: 10 });
const voteModule = modules.data.data.find((m) => m.name === 'test-vote-restart');
if (!voteModule) throw new Error('vote module missing');
const voteDetail = await client.module.moduleControllerGetOne(voteModule.id);
const checkVoteCronjobId = voteDetail.data.data.latestVersion.cronJobs.find((c) => c.name === 'check-vote')?.id;
if (!checkVoteCronjobId) throw new Error('check-vote cronjob missing');

const checks = [];

async function verifyCommand(bot, message, contains = []) {
  const after = new Date();
  await botChat(bot, message);
  const event = await waitForEvent('command-executed', after);
  const logs = commandLogs(event);
  const success = Boolean(event.meta?.result?.success);
  for (const fragment of contains) {
    if (!logs.some((msg) => msg.includes(fragment))) {
      throw new Error(`Expected command ${message} logs to contain '${fragment}', got: ${JSON.stringify(logs)}`);
    }
  }
  checks.push({ type: 'command', bot, message, success, logs });
  if (!success) throw new Error(`Command failed: ${message} logs=${JSON.stringify(logs)}`);
  return { event, logs };
}

await verifyCommand(adminName, `${prefix}casino`, ['roulette (/bet)', 'blackjack (/bj)']);
await verifyCommand(playerName, `${prefix}roulette 5 red`, ['Spun']);
const blackjackStart = await verifyCommand(playerName, `${prefix}blackjack 5`, ['🃏']);
if (blackjackStart.logs.some((msg) => msg.includes('Dealer shows')) || blackjackStart.logs.some((msg) => msg.includes('/bj hit'))) {
  await verifyCommand(playerName, `${prefix}blackjack stand`, ['Dealer:']);
}
await verifyCommand(playerName, `${prefix}race 5`, ['Draw in about']);
await verifyCommand(adminName, `${prefix}casinoban ${playerUsername} 1`, ['banned from the casino']);
await verifyCommand(adminName, `${prefix}casinounban ${playerUsername}`, ['can use the casino again']);
await verifyCommand(playerName, `${prefix}flip 1 heads`);
await verifyCommand(adminName, `${prefix}voterestart`, ['vote started']);
await verifyCommand(playerName, `${prefix}voteyes`, ['Vote passed']);

const cronAfter = new Date();
await client.cronjob.cronJobControllerTrigger({ gameServerId, cronjobId: checkVoteCronjobId, moduleId: voteModule.id });
const cronEvent = await waitForEvent('cronjob-executed', cronAfter, (event) => event.meta?.cronjob?.name === 'check-vote');
checks.push({ type: 'cronjob', name: 'check-vote', success: Boolean(cronEvent.meta?.result?.success), logs: commandLogs(cronEvent) });
if (!cronEvent.meta?.result?.success) throw new Error(`Cronjob failed: ${JSON.stringify(commandLogs(cronEvent))}`);

console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), checks }, null, 2));
