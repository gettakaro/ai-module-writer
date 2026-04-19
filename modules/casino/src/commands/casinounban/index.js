import { data, TakaroUserError, takaro } from '@takaro/helpers';
import { requireManagePermission, resolvePlayerByName, clearBan } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  requireManagePermission(pog);
  const targetName = String(args.player ?? '').trim();
  if (!targetName) throw new TakaroUserError('Usage: /casinounban <player>');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player \"${targetName}\" not found.`);
  await clearBan(gameServerId, mod.moduleId, target.playerId);

  let removedPermissionRoles = 0;
  try {
    const playerRes = await takaro.player.playerControllerGetOne(target.playerId);
    const roles = playerRes.data.data.roles ?? [];
    for (const role of roles) {
      const hasCasinoBan = (role.permissions ?? []).some((perm) => perm.permission === 'CASINO_BANNED');
      if (!hasCasinoBan) continue;
      await takaro.player.playerControllerRemoveRole(target.playerId, role.id, { gameServerId });
      removedPermissionRoles += 1;
    }
  } catch (err) {
    console.error(`casino.casinounban: failed to remove CASINO_BANNED role assignments for ${target.playerId}: ${err}`);
  }

  await pog.pm(`✅ ${target.player?.name ?? targetName} can use the casino again.${removedPermissionRoles > 0 ? ` Removed ${removedPermissionRoles} casino-ban role assignment${removedPermissionRoles === 1 ? '' : 's'}.` : ''}`);
}

await main();
