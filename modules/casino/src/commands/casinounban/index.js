import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, clearBan, setBanOverride, sendPlayerMessage } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const targetName = String(args.player ?? '').trim();
  if (!targetName) throw new TakaroUserError('Usage: /casinounban <player>');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player \"${targetName}\" not found.`);
  await clearBan(gameServerId, mod.moduleId, target.playerId);
  await setBanOverride(gameServerId, mod.moduleId, target.playerId, {
    active: true,
    clearedAt: new Date().toISOString(),
    reason: 'casinounban',
  });

  await sendPlayerMessage(
    pog,
    `✅ ${target.player?.name ?? targetName} can use the casino again. Any module-local ban was cleared, and permission-based casino bans are now overridden for this player until they are banned again.`,
  );
}

await main();
