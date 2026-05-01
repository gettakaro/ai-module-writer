import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const cfg = data.module.userConfig;
  const enabledGames = [];
  if (cfg.enableFlip !== false)      enabledGames.push('flip       — Coinflip (/flip <amount> <heads|tails>)');
  if (cfg.enableDice !== false)      enabledGames.push('dice       — Over/Under Dice (/dice <amount> <over|under> <target>)');
  if (cfg.enableHilo !== false)      enabledGames.push('hilo       — Higher/Lower Streak (/hilo <amount> to start)');
  if (cfg.enableRoulette !== false)  enabledGames.push('bet        — Roulette (/bet <amount> <red|black|green|odd|even|0-36>)');
  if (cfg.enableSlots !== false)     enabledGames.push('slots      — Slot Machine (/slots <amount>)');
  if (cfg.enableBlackjack !== false) enabledGames.push('bj         — Blackjack (/bj <amount> to deal)');
  if (cfg.enableCrash !== false)     enabledGames.push('crash      — Crash Multiplier (/crash <amount> <cashoutAt>)');
  if (cfg.enableDuel !== false)      enabledGames.push('duel       — PvP Rock-Paper-Scissors (/duel <player> <amount>)');
  if (cfg.enableRace !== false)      enabledGames.push('race       — Race Pool (/race <amount>)');

  const lines = [
    '=== CASINO ===',
    `Bet limits: ${cfg.minBet ?? 1} - ${cfg.maxBet ?? 1000} coins | House edge: ${cfg.houseEdgePct ?? 2}%`,
    '',
    'Available games:',
    ...enabledGames,
    '',
    'Info: /jackpot  /casinostats  /casinotop <wager|won|winrate|biggest>',
  ];

  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
    message: lines.join('\n'),
    opts: { recipient: { gameId: data.pog.gameId } },
  });
}
await main();
