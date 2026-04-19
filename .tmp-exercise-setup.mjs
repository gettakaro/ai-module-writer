import { Client } from '@takaro/apiclient';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const client = new Client({
  url: 'https://api.next.takaro.dev',
  auth: { username: 'root@loud-schools-drive.com', password: '0de3408bb582916e71f21c7358ce8c2162c0768a' },
  log: false,
});
await client.login();
client.setDomain('loud-schools-drive');

const GAME_SERVER_ID = 'c423b25e-c2af-4ea1-ab0a-a559574d1b65';
const MODULE_TO_JSON_SCRIPT = '/home/catalysm/code/takaro/ai-module-writer-2/dist/scripts/module-to-json.js';

async function pushModule(moduleDir) {
  const tempFile = path.join(os.tmpdir(), `takaro-push-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    execFileSync(process.execPath, [MODULE_TO_JSON_SCRIPT, moduleDir, tempFile], { stdio: 'pipe' });
    const moduleJson = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    const name = moduleJson.name;
    const existing = await client.module.moduleControllerSearch({ filters: { name: [name] } });
    const existingModule = existing.data.data.find((m) => m.name === name);
    const backup = existingModule ? (await client.module.moduleControllerExport(existingModule.id, {})).data.data : null;
    if (existingModule) await client.module.moduleControllerRemove(existingModule.id);
    try {
      await client.module.moduleControllerImport(moduleJson);
    } catch (err) {
      if (backup) await client.module.moduleControllerImport(backup);
      throw err;
    }
    const searchResult = await client.module.moduleControllerSearch({ filters: { name: [name] } });
    const found = searchResult.data.data.find((m) => m.name === name);
    if (!found) throw new Error(`Module not found after import: ${name}`);
    return found;
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

async function installModule(versionId, userConfig) {
  return client.module.moduleInstallationsControllerInstallModule({
    versionId,
    gameServerId: GAME_SERVER_ID,
    userConfig: JSON.stringify(userConfig),
  });
}

async function findPlayerId(name) {
  const res = await client.player.playerControllerSearch({ search: { name: [name] }, limit: 20 });
  const found = res.data.data.find((p) => p.name === name);
  if (!found) throw new Error(`Player not found: ${name}`);
  return found.id;
}

async function assignPermissions(playerId, permissionCodes) {
  const allPerms = await client.role.roleControllerGetPermissions();
  const permissions = permissionCodes.map((code) => {
    const found = allPerms.data.data.find((p) => p.permission === code);
    if (!found) throw new Error(`Permission not found: ${code}`);
    return { permissionId: found.id };
  });
  const role = await client.role.roleControllerCreate({
    name: `ex-${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(-4)}`,
    permissions,
  });
  await client.player.playerControllerAssignRole(playerId, role.data.data.id, { gameServerId: GAME_SERVER_ID });
  return role.data.data.id;
}

const utilsModule = await pushModule('/home/catalysm/code/takaro/ai-module-writer-2/modules/utils');
await installModule(utilsModule.latestVersion.id, {
  discordLink: 'https://discord.gg/takaro',
  rules: ['No griefing', 'Be respectful', 'No cheating'],
  serverInfoMessage: 'No griefing outside claim areas. Join Discord with /discord',
  broadcastCurrencyGrants: true,
  currencyGrantBroadcastMessage: '{player} received {amount} currency from {admin}.',
  broadcastKicks: true,
  kickBroadcastMessage: '{player} was kicked by {admin}. Reason: {reason}',
  broadcastBans: true,
  banBroadcastMessage: '{player} was banned by {admin} for {duration}. Reason: {reason}',
});

const cfModule = await pushModule('/home/catalysm/code/takaro/ai-module-writer-2/modules/community-fund');
await installModule(cfModule.latestVersion.id, {
  fundThreshold: 20,
  minimumContribution: 10,
  completionMessage: 'The community fund reached {threshold}!',
  completionCommands: [],
  broadcastContributions: true,
});

const adminbotId = await findPlayerId('Bot_adminbot');
const cfadminId = await findPlayerId('Bot_cfadmin');
const cftwoId = await findPlayerId('Bot_cftwo');

const role1 = await assignPermissions(adminbotId, ['UTILS_KICK', 'UTILS_BAN', 'UTILS_GIVE_CURRENCY']);
const role2 = await assignPermissions(cfadminId, ['COMMUNITY_FUND_CONTRIBUTE', 'COMMUNITY_FUND_VIEW_HISTORY']);
const role3 = await assignPermissions(cftwoId, ['COMMUNITY_FUND_CONTRIBUTE']);

console.log(JSON.stringify({
  utilsModuleId: utilsModule.id,
  utilsVersionId: utilsModule.latestVersion.id,
  cfModuleId: cfModule.id,
  cfVersionId: cfModule.latestVersion.id,
  role1,
  role2,
  role3,
}, null, 2));
