import { data, TakaroUserError } from '@takaro/helpers';
import { getDefaultConfig, getPlayerStats, getWindowData, resolvePlayerByName, getPlayerName, formatCurrency, getVipTier, getVipMultiplier, getNextWindowResetAt, formatFutureTime } from './casino-helpers.js';

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

  const vipTier = targetId === player.id ? getVipTier(pog) : 0;
  const vipMultiplier = getVipMultiplier(vipTier);
  const wagerCap = config.wagerCap > 0 ? Math.floor(config.wagerCap * vipMultiplier) : 0;
  const lossCap = config.lossCap > 0 ? Math.floor(config.lossCap * vipMultiplier) : 0;
  const resetAt = getNextWindowResetAt(config.capWindow);

  const lines = [
    `📊 Casino stats for ${targetName}`,
    `Lifetime wagered: ${formatCurrency(stats.wagered)} | won: ${formatCurrency(stats.won)} | net: ${formatCurrency(stats.net)}`,
    `Games played: ${stats.gamesPlayed} | biggest win: ${formatCurrency(stats.biggestWin?.amount ?? 0)}${stats.biggestWin?.game ? ` on ${stats.biggestWin.game}` : ''}`,
    `Current ${config.capWindow} window — wagered: ${formatCurrency(windowData.wagered)} | lost: ${formatCurrency(windowData.lost)}`,
    `Window reset: ${formatFutureTime(resetAt.toISOString())}`,
    `Wager cap: ${wagerCap > 0 ? `${formatCurrency(wagerCap)} (${formatCurrency(Math.max(0, wagerCap - windowData.wagered))} remaining)` : 'unlimited'}`,
    `Loss cap: ${lossCap > 0 ? `${formatCurrency(lossCap)} (${formatCurrency(Math.max(0, lossCap - windowData.lost))} remaining)` : 'unlimited'}`,
  ];
  await pog.pm(lines.join('\n'));
}

await main();
