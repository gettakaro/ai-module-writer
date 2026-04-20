import { createClient } from '../test/helpers/client.ts';
import { pushModule, installModule, uninstallModule, getCommandPrefix, assignPermissions } from '../test/helpers/modules.ts';

const client = await createClient();
const gameServerId = '95473107-f960-4cd0-a15f-ede2e089e64a';

async function findPlayerIdByName(name) {
  const res = await client.player.playerControllerSearch({ filters: { name: [name] }, limit: 10 });
  const found = res.data.data.find((p) => p.name === name);
  if (!found) throw new Error(`Player not found: ${name}`);
  return found.id;
}

async function uninstallIfInstalled(moduleName) {
  const mods = await client.module.moduleControllerSearch({ filters: { name: [moduleName] }, limit: 10 });
  const mod = mods.data.data.find((m) => m.name === moduleName);
  if (!mod) return;
  try {
    await uninstallModule(client, mod.id, gameServerId);
  } catch {}
}

await uninstallIfInstalled('casino');
await uninstallIfInstalled('test-vote-restart');

const casino = await pushModule(client, 'modules/casino');
await installModule(client, casino.latestVersion.id, gameServerId, {
  userConfig: {
    minBet: 1,
    maxBet: 1000,
    cooldownSeconds: 0,
    houseEdgePct: 2,
    jackpotContributionPct: 10,
    bigWinThreshold: 999999,
  },
});

const vote = await pushModule(client, 'modules/vote-restart');
await installModule(client, vote.latestVersion.id, gameServerId, {
  userConfig: {
    voteDuration: 120,
    cooldownDuration: 60,
    restartDelay: 0,
    restartCommand: 'say restart-test',
    passThreshold: 100,
    minimumPlayers: 2,
  },
});

const adminPlayerId = await findPlayerIdByName('Bot_BotAdmin');
const playerPlayerId = await findPlayerIdByName('Bot_BotPlayer');

const casinoPlayAdminRoleId = await assignPermissions(client, adminPlayerId, gameServerId, ['CASINO_PLAY', 'CASINO_MANAGE', 'VOTE_RESTART_INITIATE']);
const casinoPlayPlayerRoleId = await assignPermissions(client, playerPlayerId, gameServerId, ['CASINO_PLAY']);

const prefix = await getCommandPrefix(client, gameServerId);
console.log(JSON.stringify({
  gameServerId,
  prefix,
  casinoModuleId: casino.id,
  voteModuleId: vote.id,
  adminPlayerId,
  playerPlayerId,
  roleIds: { casinoPlayAdminRoleId, casinoPlayPlayerRoleId },
}, null, 2));
