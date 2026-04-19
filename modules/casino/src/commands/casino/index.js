import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { getDefaultConfig, sendPlayerMessage } from './casino-helpers.js';

async function main() {
  const { pog, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const game = String(args.game ?? '?').toLowerCase();

  const gameHelp = {
    flip: '🪙 /flip <amount> <heads|tails> — fast 50/50 coin flip.',
    dice: '🎲 /dice <amount> <over|under> <2-98> — higher risk, higher payout.',
    hilo: '🎴 /hilo <amount> to start, then /hilo higher, /hilo lower, or /hilo cashout.',
    roulette: '🎡 Roulette uses /bet <amount> <red|black|odd|even|green|0-36> — the trigger is /bet, not /casino roulette.',
    bet: '🎡 /bet <amount> <red|black|odd|even|green|0-36> — European roulette.',
    slots: '🎰 /slots <amount> — 3 reels, pairs pay, triple 7s hit the jackpot.',
    blackjack: '🃏 Blackjack uses /bj <amount> to deal, then /bj hit, /bj stand, or /bj double — the trigger is /bj.',
    bj: '🃏 /bj <amount> to deal, then /bj hit, /bj stand, or /bj double.',
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
  if (config.games.flip) enabled.push('flip');
  if (config.games.dice) enabled.push('dice');
  if (config.games.hilo) enabled.push('hilo');
  if (config.games.roulette) enabled.push('roulette (/bet)');
  if (config.games.slots) enabled.push('slots');
  if (config.games.blackjack) enabled.push('blackjack (/bj)');
  if (config.games.crash) enabled.push('crash');
  if (config.games.duel) enabled.push('duel');
  if (config.games.race) enabled.push('race');

  const lines = [
    '🎰 Casino games: ' + enabled.join(', '),
    `Min bet: ${config.minBet} | Base max bet: ${config.maxBet} | Window: ${config.capWindow}`,
    'Player commands: /casinostats, /casinotop <wager|won|winrate|roi|biggest>, /jackpot',
  ];

  if (checkPermission(pog, 'CASINO_MANAGE')) {
    lines.push('Admin commands: /casinoreport [days], /casinoban <player> [hours], /casinounban <player>, /casinoresetstats <player>, /setjackpot <amount>');
  }

  lines.push('Tip: /casino <game> shows focused help for one game. Roulette is /bet and blackjack is /bj.');
  await sendPlayerMessage(pog, lines.join('\n'));
}

await main();
