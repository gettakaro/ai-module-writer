import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { getDefaultConfig, sendPlayerMessage, assertNoLegacyCasinoModules, getBan, formatFutureTime } from './casino-helpers.js';

async function main() {
  const { gameServerId, player, pog, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const game = String(args.game ?? '?').toLowerCase();

  const gameHelp = {
    flip: '🪙 /flip <amount> <heads|tails> — fast 50/50 coin flip.',
    dice: '🎲 /dice <amount> <over|under> <2-98> — higher risk, higher payout.',
    hilo: '🎴 /hilo <amount> to start, then /hilo higher, /hilo lower, or /hilo cashout.',
    roulette: '🎡 /roulette <amount> <red|black|odd|even|green|0-36> — European roulette. /bet works as an alias.',
    bet: '🎡 /roulette <amount> <red|black|odd|even|green|0-36> — /bet also works as a roulette alias.',
    slots: '🎰 /slots <amount> — 3 reels, pairs pay, triple 7s hit the jackpot.',
    blackjack: '🃏 /blackjack <amount> to deal, then /blackjack hit, /blackjack stand, or /blackjack double. /bj also works.',
    bj: '🃏 /blackjack <amount> to deal, then /blackjack hit, /blackjack stand, or /blackjack double. /bj also works.',
    crash: '🚀 /crash <amount> <cashoutAt> — auto-cashout crash game.',
    duel: '⚔️ /duel <player> <amount> to challenge, then accept/decline and pick rock/paper/scissors.',
    race: '🏁 /race [amount] — view the current weighted race pot or join it with a stake.',
  };

  const gameAliases = {
    flip: 'flip',
    dice: 'dice',
    hilo: 'hilo',
    roulette: 'roulette',
    bet: 'roulette',
    slots: 'slots',
    blackjack: 'blackjack',
    bj: 'blackjack',
    crash: 'crash',
    duel: 'duel',
    race: 'race',
  };

  let playUnavailableReason = null;
  if (!checkPermission(pog, 'CASINO_PLAY')) {
    playUnavailableReason = 'You do not currently have access to casino games on this server.';
  } else if (checkPermission(pog, 'CASINO_BANNED')) {
    playUnavailableReason = 'You are banned from the casino.';
  } else {
    const ban = await getBan(gameServerId, mod.moduleId, player.id);
    if (ban) {
      playUnavailableReason = ban.expiresAt
        ? `You are banned from the casino until ${formatFutureTime(ban.expiresAt)}.`
        : 'You are banned from the casino.';
    }
  }

  if (!playUnavailableReason) {
    try {
      await assertNoLegacyCasinoModules(gameServerId, mod.moduleId);
    } catch (err) {
      playUnavailableReason = String(err?.message ?? err ?? 'Old gambling modules are still installed.');
    }
  }

  if (game !== '?' && gameHelp[game]) {
    const normalizedGame = gameAliases[game];
    if (normalizedGame && config.games?.[normalizedGame] === false) {
      throw new TakaroUserError(`The ${normalizedGame} game is disabled on this server.`);
    }
    await sendPlayerMessage(pog, gameHelp[game]);
    return;
  }

  if (game !== '?') {
    throw new TakaroUserError(`Unknown casino game "${args.game}". Try flip, dice, hilo, roulette, bet, slots, blackjack, bj, crash, duel, or race.`);
  }

  const enabled = [];
  if (!playUnavailableReason) {
    if (config.games.flip) enabled.push('flip');
    if (config.games.dice) enabled.push('dice');
    if (config.games.hilo) enabled.push('hilo');
    if (config.games.roulette) enabled.push('roulette');
    if (config.games.slots) enabled.push('slots');
    if (config.games.blackjack) enabled.push('blackjack');
    if (config.games.crash) enabled.push('crash');
    if (config.games.duel) enabled.push('duel');
    if (config.games.race) enabled.push('race');
  }

  const lines = playUnavailableReason
    ? [
      `🎰 Casino overview: unavailable right now. ${playUnavailableReason}`,
      'Utility commands: /casinostats, /casinotop <wager|won|winrate|roi|biggest>, /jackpot',
    ]
    : [
      '🎰 Casino games: ' + enabled.join(', '),
      `Min bet: ${config.minBet} | Base max bet: ${config.maxBet} | Window: ${config.capWindow}`,
      'Player commands: /casinostats, /casinotop <wager|won|winrate|roi|biggest>, /jackpot',
    ];

  if (checkPermission(pog, 'CASINO_MANAGE')) {
    lines.push('Admin commands: /casinoreport [days], /casinoban <player> [hours], /casinounban <player>, /casinoresetstats <player>, /setjackpot <amount>');
  }

  if (playUnavailableReason) {
    lines.push('If this seems wrong, ask an admin to grant you casino access, remove conflicting legacy gambling modules, or clear your casino ban.');
  } else {
    lines.push('Tip: /casino <game> shows focused help for one game. You can use /roulette or /bet, and /blackjack or /bj.');
  }
  await sendPlayerMessage(pog, lines.join('\n'));
}

await main();
