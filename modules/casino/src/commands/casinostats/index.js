import { data, TakaroUserError } from '@takaro/helpers';
import { getDefaultConfig, getPlayerStats, getWindowData, resolvePlayerByName, getPlayerName, formatCurrency } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  let targetId = player.id;
  let targetName = player.name;
  const raw = String(args.player ?? '?');
  if (raw !== '?' && raw.trim()) {
    const targetPog = await resolvePlayerByName(raw.trim(), gameServerId);
    if (!targetPog) throw new TakaroUserError(`Player \"${raw}\" not found on this game server.`);
    targetId = targetPog.playerId;
    targetName = targetPog.player?.name ?? await getPlayerName(targetId);
  }

  const [stats, windowData] = await Promise.all([
    getPlayerStats(gameServerId, mod.moduleId, targetId),
    getWindowData(gameServerId, mod.moduleId, targetId, config),
  ]);

  const lines = [
    `📊 Casino stats for ${targetName}`,
    `Lifetime wagered: ${formatCurrency(stats.wagered)} | won: ${formatCurrency(stats.won)} | net: ${formatCurrency(stats.net)}`,
    `Games played: ${stats.gamesPlayed} | biggest win: ${formatCurrency(stats.biggestWin?.amount ?? 0)}${stats.biggestWin?.game ? ` on ${stats.biggestWin.game}` : ''}`,
    `Current ${config.capWindow} window — wagered: ${formatCurrency(windowData.wagered)} | lost: ${formatCurrency(windowData.lost)}`,
  ];
  await pog.pm(lines.join('\n'));
}

await main();
