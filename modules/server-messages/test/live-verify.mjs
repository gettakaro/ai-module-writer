#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const BOT_PORT = Number(process.env.BOT_PORT || 3101);
const MODULE_NAME = 'server-messages';
const BOT_NAME = `srvmsg${Math.random().toString(36).slice(2, 8)}`;
const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-messages-live-'));

function run(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
}

function api(method, endpoint, body = {}) {
  const output = run('bash', ['scripts/takaro-api.sh', method, endpoint, JSON.stringify(body)]);
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function botRequest(method, pathname, body) {
  const response = await fetch(`http://localhost:${BOT_PORT}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 404 && method === 'DELETE') return;
  if (!response.ok) {
    throw new Error(`Bot API ${method} ${pathname} failed: ${response.status} ${await response.text()}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function toLogs(event) {
  return event?.meta?.result?.logs?.map((entry) => entry.msg) ?? [];
}

function getSuccess(event) {
  return event?.meta?.result?.success ?? false;
}

function listEvents(events) {
  return [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function summarizeStep(stepName, cronEvent, chatEvents) {
  return {
    stepName,
    cronSuccess: getSuccess(cronEvent),
    cronLogs: toLogs(cronEvent),
    chatMessages: chatEvents.map((event) => event.meta?.msg).filter(Boolean),
  };
}

function assertCondition(results, description, condition, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ description, status, detail });
  console.log(`[${status}] ${description}`);
  if (detail) console.log(`       ${detail}`);
}

function extractRenderedSeqA(message, serverName) {
  return typeof message === 'string' && /^Seq A \(\d+ online @ .+\)$/.test(message) && message.includes(`@ ${serverName})`);
}

function pickGameServer(gameServers) {
  const requestedId = process.env.SERVER_MESSAGES_GAMESERVER_ID;
  if (requestedId) {
    const exact = gameServers.find((server) => server.id === requestedId);
    if (!exact) throw new Error(`SERVER_MESSAGES_GAMESERVER_ID=${requestedId} was not found in Takaro`);
    return exact;
  }

  const requestedName = process.env.SERVER_MESSAGES_GAMESERVER_NAME;
  if (requestedName) {
    const exact = gameServers.find((server) => server.name === requestedName);
    if (!exact) throw new Error(`SERVER_MESSAGES_GAMESERVER_NAME=${requestedName} was not found in Takaro`);
    return exact;
  }

  const candidates = gameServers.filter((server) => !server.name.startsWith('test-'));
  const paperLike = candidates.filter((server) => /paper|minecraft/i.test(server.name));

  if (paperLike.length === 1) return paperLike[0];
  if (candidates.length === 1) return candidates[0];

  const printable = candidates.map((server) => `${server.name} (${server.id})`).join(', ') || 'none';
  throw new Error(
    `Unable to choose a unique live Paper server automatically. Set SERVER_MESSAGES_GAMESERVER_ID or SERVER_MESSAGES_GAMESERVER_NAME. Candidates: ${printable}`,
  );
}

async function waitForInstallation(moduleId, gameServerId, shouldExist) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      api('GET', `/module/${moduleId}/gameserver/${gameServerId}/installation`, {});
      if (shouldExist) return;
    } catch (error) {
      const message = String(error);
      if (message.includes('404')) {
        if (!shouldExist) return;
      } else {
        throw error;
      }
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for installation state shouldExist=${shouldExist}`);
}

async function uninstallIfPresent(moduleId, gameServerId) {
  try {
    api('DELETE', `/module/${moduleId}/gameserver/${gameServerId}/installation`, {});
  } catch (error) {
    const message = String(error).toLowerCase();
    if (!message.includes('404') && !message.includes('not installed')) throw error;
  }
  await waitForInstallation(moduleId, gameServerId, false);
}

async function install(versionId, moduleId, gameServerId, userConfig) {
  await uninstallIfPresent(moduleId, gameServerId);
  api('POST', '/module/installation/', {
    versionId,
    gameServerId,
    userConfig: JSON.stringify(userConfig),
  });
  await waitForInstallation(moduleId, gameServerId, true);
}

async function fetchEvents(gameServerId, eventName, after, limit = 20) {
  const result = api('POST', '/event/search', {
    filters: {
      gameserverId: [gameServerId],
      eventName: [eventName],
    },
    greaterThan: {
      createdAt: after,
    },
    sortBy: 'createdAt',
    sortDirection: 'asc',
    limit,
    page: 0,
  });

  return listEvents(result?.data ?? []);
}

async function trigger(gameServerId, moduleId, cronjobId, label) {
  const after = new Date().toISOString();
  api('POST', '/cronjob/trigger', {
    gameServerId,
    moduleId,
    cronjobId,
  });

  let cronEvents = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    cronEvents = await fetchEvents(gameServerId, 'cronjob-executed', after, 5);
    if (cronEvents.length > 0) break;
    await sleep(500);
  }

  await sleep(1500);
  const chatEvents = await fetchEvents(gameServerId, 'ChatMessage', after, 10);
  const summary = summarizeStep(label, cronEvents[0], chatEvents);
  summary.after = after;
  return summary;
}

const verificationResults = [];
let moduleId;
let gameServerId;

try {
  const gameServers = api('POST', '/gameserver/search', { limit: 100, page: 0 })?.data ?? [];
  const gameServer = pickGameServer(gameServers);
  gameServerId = gameServer.id;

  const moduleSearch = api('POST', '/module/search', {
    filters: { name: [MODULE_NAME] },
    limit: 20,
    page: 0,
  });
  const moduleRow = moduleSearch?.data?.find((entry) => entry.name === MODULE_NAME);
  if (!moduleRow?.latestVersion?.id) {
    throw new Error(`Module '${MODULE_NAME}' was not found after push`);
  }

  const cronjob = moduleRow.latestVersion.cronJobs.find((entry) => entry.name === 'broadcast-messages') ?? moduleRow.latestVersion.cronJobs[0];
  if (!cronjob?.id) throw new Error('Could not resolve the live cronjob id for broadcast-messages');

  moduleId = moduleRow.id;
  const versionId = moduleRow.latestVersion.id;

  console.log(`Using game server: ${gameServer.name} (${gameServer.id})`);
  console.log(`Using module: ${moduleRow.name} (${moduleId}), version ${versionId}, cronjob ${cronjob.id}`);
  console.log(`Evidence directory: ${evidenceDir}`);

  await install(versionId, moduleId, gameServerId, {
    messages: [
      { text: 'Seq A ({playerCount} online @ {serverName})' },
      { text: 'Seq B' },
    ],
    order: 'sequential',
    interval: '* * * * *',
  });

  await botRequest('DELETE', `/bots/${BOT_NAME}`);
  await botRequest('POST', '/bots', { name: BOT_NAME });
  await sleep(8000);

  const seq1 = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-1');
  const seq2 = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-2');

  await botRequest('DELETE', `/bots/${BOT_NAME}`);
  await sleep(5000);
  const seqSkip = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-skip-no-players');

  await botRequest('POST', '/bots', { name: BOT_NAME });
  await sleep(8000);
  const seqResume = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-resume-after-skip');

  await fs.writeFile(path.join(evidenceDir, 'sequential.json'), JSON.stringify({ seq1, seq2, seqSkip, seqResume }, null, 2));

  assertCondition(
    verificationResults,
    'Sequential trigger 1 delivers Seq A with live placeholders rendered',
    seq1.cronSuccess && extractRenderedSeqA(seq1.chatMessages[0], gameServer.name) && !seq1.chatMessages[0].includes('{playerCount}') && !seq1.chatMessages[0].includes('{serverName}'),
    JSON.stringify(seq1),
  );
  assertCondition(
    verificationResults,
    'Sequential trigger 2 delivers Seq B',
    seq2.cronSuccess && seq2.chatMessages[0] === 'Seq B',
    JSON.stringify(seq2),
  );
  assertCondition(
    verificationResults,
    'Zero-player trigger skips broadcasting without chat output',
    seqSkip.cronSuccess && seqSkip.chatMessages.length === 0 && seqSkip.cronLogs.some((log) => log.includes('no players online')),
    JSON.stringify(seqSkip),
  );
  assertCondition(
    verificationResults,
    'Sequential rotation resumes on Seq A after the zero-player skip',
    seqResume.cronSuccess && extractRenderedSeqA(seqResume.chatMessages[0], gameServer.name),
    JSON.stringify(seqResume),
  );

  await install(versionId, moduleId, gameServerId, {
    messages: [
      { text: 'Red', weight: 1 },
      { text: 'Gold', weight: 2 },
    ],
    order: 'random',
    interval: '* * * * *',
  });

  await botRequest('DELETE', `/bots/${BOT_NAME}`);
  await botRequest('POST', '/bots', { name: BOT_NAME });
  await sleep(8000);

  const random1 = await trigger(gameServerId, moduleId, cronjob.id, 'random-1');
  const random2 = await trigger(gameServerId, moduleId, cronjob.id, 'random-2');
  const random3 = await trigger(gameServerId, moduleId, cronjob.id, 'random-3');
  const randomMessages = [random1, random2, random3].flatMap((step) => step.chatMessages);
  const redCount = randomMessages.filter((message) => message === 'Red').length;
  const goldCount = randomMessages.filter((message) => message === 'Gold').length;

  await fs.writeFile(
    path.join(evidenceDir, 'random.json'),
    JSON.stringify({ random1, random2, random3, randomMessages, redCount, goldCount }, null, 2),
  );

  assertCondition(
    verificationResults,
    'Random weighted live run consumes one full shuffle bag with 1 Red and 2 Gold broadcasts',
    [random1, random2, random3].every((step) => step.cronSuccess) && randomMessages.length === 3 && redCount === 1 && goldCount === 2,
    JSON.stringify({ random1, random2, random3, randomMessages, redCount, goldCount }),
  );

  const failures = verificationResults.filter((result) => result.status === 'FAIL');
  console.log(`\nSummary: ${verificationResults.length - failures.length}/${verificationResults.length} checks passed.`);
  console.log(`Sequential evidence: ${path.join(evidenceDir, 'sequential.json')}`);
  console.log(`Random evidence: ${path.join(evidenceDir, 'random.json')}`);

  if (failures.length > 0) {
    throw new Error(`Live verification failed with ${failures.length} failing checks.`);
  }
} finally {
  await botRequest('DELETE', `/bots/${BOT_NAME}`).catch(() => {});
  if (moduleId && gameServerId && process.env.SERVER_MESSAGES_KEEP_INSTALLED !== '1') {
    await uninstallIfPresent(moduleId, gameServerId).catch(() => {});
  }
}
