#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const BOT_PORT = Number(process.env.BOT_PORT || 3101);
const MODULE_NAME = 'server-messages';
const BOT_NAME = `srvmsg${Math.random().toString(36).slice(2, 8)}`;
const RUN_ID = `srvmsg-${Date.now().toString(36)}`;
const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-messages-live-'));
const repoEvidencePath = path.join(ROOT_DIR, 'modules/server-messages/test/live-verification.latest.json');
const DISABLED_TEMPORAL_VALUE = '0 0 31 2 *';

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();

  if (result.status !== 0 && !allowFailure) {
    const error = new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    error.status = result.status;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }

  return {
    status: result.status ?? 0,
    stdout,
    stderr,
  };
}

function api(method, endpoint, body = {}, options = {}) {
  const result = run('bash', ['scripts/takaro-api.sh', method, endpoint, JSON.stringify(body)], options);
  if (!result.stdout) return null;

  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFoundError(error) {
  const combined = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n').toLowerCase();
  return combined.includes('404') || combined.includes('not found') || combined.includes('not installed');
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

function summarizeStep(stepName, cronEvent, allChatEvents, matchedChatEvents) {
  return {
    stepName,
    cronSuccess: getSuccess(cronEvent),
    cronLogs: toLogs(cronEvent),
    matchedChatMessages: matchedChatEvents.map((event) => event.meta?.msg).filter(Boolean),
    nearbyChatMessages: allChatEvents.map((event) => event.meta?.msg).filter(Boolean),
  };
}

function assertCondition(results, description, condition, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ description, status, detail });
  console.log(`[${status}] ${description}`);
  if (detail) console.log(`       ${detail}`);
}

function extractRenderedSeqA(message, serverName) {
  const expectedPrefix = `Seq A [${RUN_ID}] (`;
  return (
    typeof message === 'string' &&
    message.startsWith(expectedPrefix) &&
    /^Seq A \[[^\]]+\] \(\d+ online @ .+\)$/.test(message) &&
    message.includes(`@ ${serverName})`)
  );
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

async function waitForBotApi() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await botRequest('GET', '/status');
      return;
    } catch {
      await sleep(1000);
    }
  }

  throw new Error(`Timed out waiting for bot API on port ${BOT_PORT}`);
}

async function waitForGameServerSelection() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const gameServers = api('POST', '/gameserver/search', { limit: 100, page: 0 })?.data ?? [];
    try {
      return pickGameServer(gameServers);
    } catch (error) {
      if (String(error.message ?? error).includes('Candidates: none')) {
        await sleep(2000);
        continue;
      }
      throw error;
    }
  }

  throw new Error('Timed out waiting for a live Paper server to appear in Takaro');
}

async function waitForInstallation(moduleId, gameServerId, shouldExist) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      api('GET', `/module/${moduleId}/gameserver/${gameServerId}/installation`, {});
      if (shouldExist) return;
    } catch (error) {
      if (isNotFoundError(error)) {
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
    if (!isNotFoundError(error)) throw error;
  }
  await waitForInstallation(moduleId, gameServerId, false);
}

async function install(versionId, moduleId, gameServerId, userConfig) {
  await uninstallIfPresent(moduleId, gameServerId);

  try {
    api('POST', '/module/installation/', {
      versionId,
      gameServerId,
      userConfig: JSON.stringify(userConfig),
    });
  } catch (error) {
    await waitForInstallation(moduleId, gameServerId, true).catch(() => {
      throw error;
    });
    console.warn(`Install request returned an error, but installation was observed live and will be treated as success: ${error.stderr ?? error.message}`);
    return;
  }

  await waitForInstallation(moduleId, gameServerId, true);
}

async function fetchEvents(filters, after, limit = 20) {
  const result = api('POST', '/event/search', {
    filters,
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

async function updateCronjobSchedule(cronjobId) {
  api('PUT', `/cronjob/${cronjobId}`, {
    temporalValue: DISABLED_TEMPORAL_VALUE,
  });
}

async function waitForBotPresence(shouldExist) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const status = await botRequest('GET', '/status');
    const exists = Boolean(status?.[BOT_NAME]?.connected);
    if (exists === shouldExist) return status?.[BOT_NAME] ?? null;
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for bot ${BOT_NAME} shouldExist=${shouldExist}`);
}

async function waitForOnlinePlayerCount(gameServerId, minimumCount) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = api('POST', '/gameserver/player/search', {
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      limit: 5,
      page: 0,
    });

    const count = Number(result?.meta?.total ?? result?.data?.length ?? 0);
    if (count >= minimumCount) return count;
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${minimumCount} online players on gameserver ${gameServerId}`);
}

async function trigger(gameServerId, moduleId, cronjobId, label) {
  const after = new Date().toISOString();
  api('POST', '/cronjob/trigger', {
    gameServerId,
    moduleId,
    cronjobId,
  });

  let cronEvent;
  for (let attempt = 0; attempt < 40; attempt++) {
    const cronEvents = await fetchEvents(
      {
        gameserverId: [gameServerId],
        moduleId: [moduleId],
        eventName: ['cronjob-executed'],
      },
      after,
      10,
    );
    if (cronEvents.length > 0) {
      cronEvent = cronEvents[0];
      break;
    }
    await sleep(500);
  }

  if (!cronEvent) {
    throw new Error(`Timed out waiting for cronjob-executed event for ${label}`);
  }

  await sleep(1500);
  const allChatEvents = await fetchEvents(
    {
      gameserverId: [gameServerId],
      eventName: ['chat-message'],
    },
    after,
    20,
  );
  const matchedChatEvents = allChatEvents.filter((event) => String(event.meta?.msg ?? '').includes(RUN_ID));
  const summary = summarizeStep(label, cronEvent, allChatEvents, matchedChatEvents);
  summary.after = after;
  return summary;
}

const verificationResults = [];
let moduleId;
let gameServerId;
let gameServer;
let moduleRow;
let evidenceReport;

try {
  await waitForBotApi();
  gameServer = await waitForGameServerSelection();
  gameServerId = gameServer.id;

  const moduleSearch = api('POST', '/module/search', {
    filters: { name: [MODULE_NAME] },
    limit: 20,
    page: 0,
  });
  moduleRow = moduleSearch?.data?.find((entry) => entry.name === MODULE_NAME);
  if (!moduleRow?.latestVersion?.id) {
    throw new Error(`Module '${MODULE_NAME}' was not found after push`);
  }

  const cronjob = moduleRow.latestVersion.cronJobs.find((entry) => entry.name === 'broadcast-messages') ?? moduleRow.latestVersion.cronJobs[0];
  if (!cronjob?.id) throw new Error('Could not resolve the live cronjob id for broadcast-messages');

  moduleId = moduleRow.id;
  const versionId = moduleRow.latestVersion.id;

  await updateCronjobSchedule(cronjob.id);

  console.log(`Using game server: ${gameServer.name} (${gameServer.id})`);
  console.log(`Using module: ${moduleRow.name} (${moduleId}), version ${versionId}, cronjob ${cronjob.id}`);
  console.log(`Run id: ${RUN_ID}`);
  console.log(`Evidence directory: ${evidenceDir}`);
  console.log(`Repo evidence file: ${repoEvidencePath}`);

  await install(versionId, moduleId, gameServerId, {
    messages: [
      { text: `Seq A [${RUN_ID}] ({playerCount} online @ {serverName})` },
      { text: `Seq B [${RUN_ID}]` },
    ],
    order: 'sequential',
    interval: '* * * * *',
  });

  await botRequest('DELETE', `/bots/${BOT_NAME}`);
  await botRequest('POST', '/bots', { name: BOT_NAME });
  await waitForBotPresence(true);
  await waitForOnlinePlayerCount(gameServerId, 1);

  const seq1 = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-1');
  const seq2 = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-2');

  await botRequest('DELETE', `/bots/${BOT_NAME}`);
  await waitForBotPresence(false);
  const seqSkip = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-skip-no-players');

  await botRequest('POST', '/bots', { name: BOT_NAME });
  await waitForBotPresence(true);
  await waitForOnlinePlayerCount(gameServerId, 1);
  const seqResume = await trigger(gameServerId, moduleId, cronjob.id, 'sequential-resume-after-skip');

  await fs.writeFile(path.join(evidenceDir, 'sequential.json'), JSON.stringify({ seq1, seq2, seqSkip, seqResume }, null, 2));

  assertCondition(
    verificationResults,
    'Sequential trigger 1 delivers Seq A with live placeholders rendered',
    seq1.cronSuccess && extractRenderedSeqA(seq1.matchedChatMessages[0], gameServer.name) && !seq1.matchedChatMessages[0].includes('{playerCount}') && !seq1.matchedChatMessages[0].includes('{serverName}'),
    JSON.stringify(seq1),
  );
  assertCondition(
    verificationResults,
    'Sequential trigger 2 delivers Seq B',
    seq2.cronSuccess && seq2.matchedChatMessages[0] === `Seq B [${RUN_ID}]`,
    JSON.stringify(seq2),
  );
  assertCondition(
    verificationResults,
    'Zero-player trigger skips broadcasting without matched chat output',
    seqSkip.cronSuccess && seqSkip.matchedChatMessages.length === 0 && seqSkip.cronLogs.some((log) => log.includes('no players online')),
    JSON.stringify(seqSkip),
  );
  assertCondition(
    verificationResults,
    'Sequential rotation resumes on Seq A after the zero-player skip',
    seqResume.cronSuccess && extractRenderedSeqA(seqResume.matchedChatMessages[0], gameServer.name),
    JSON.stringify(seqResume),
  );

  await install(versionId, moduleId, gameServerId, {
    messages: [
      { text: `Red [${RUN_ID}]`, weight: 1 },
      { text: `Gold [${RUN_ID}]`, weight: 2 },
    ],
    order: 'random',
    interval: '* * * * *',
  });

  await botRequest('DELETE', `/bots/${BOT_NAME}`);
  await botRequest('POST', '/bots', { name: BOT_NAME });
  await waitForBotPresence(true);
  await waitForOnlinePlayerCount(gameServerId, 1);

  const random1 = await trigger(gameServerId, moduleId, cronjob.id, 'random-1');
  const random2 = await trigger(gameServerId, moduleId, cronjob.id, 'random-2');
  const random3 = await trigger(gameServerId, moduleId, cronjob.id, 'random-3');
  const randomMessages = [random1, random2, random3].flatMap((step) => step.matchedChatMessages);
  const redCount = randomMessages.filter((message) => message === `Red [${RUN_ID}]`).length;
  const goldCount = randomMessages.filter((message) => message === `Gold [${RUN_ID}]`).length;

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
  evidenceReport = {
    executedAt: new Date().toISOString(),
    runId: RUN_ID,
    gameServer: { id: gameServer.id, name: gameServer.name },
    module: { id: moduleId, versionId },
    cronjobId: cronjob.id,
    evidenceDir,
    sequentialEvidenceFile: path.join(evidenceDir, 'sequential.json'),
    randomEvidenceFile: path.join(evidenceDir, 'random.json'),
    results: verificationResults,
    passedChecks: verificationResults.length - failures.length,
    totalChecks: verificationResults.length,
  };

  await fs.writeFile(repoEvidencePath, `${JSON.stringify(evidenceReport, null, 2)}\n`);

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
