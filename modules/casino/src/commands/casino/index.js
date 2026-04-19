import { data } from '@takaro/helpers';
import { getDefaultConfig } from './casino-helpers.js';

async function main() {
  const { pog, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const game = String(args.game ?? '?').toLowerCase();

  const gameHelp = {
    flip: '🪙 /flip <amount> <heads|tails> — fast 50/50 coin flip.',
    dice: '🎲 /dice <amount> <over|under> <2-98> — higher risk, higher payout.',
    hilo: '🎴 /hilo <amount> to start, then /hilo higher, /hilo lower, or /hilo cashout.',
    roulette: '🎡 Roulette uses /bet <amount> <red|black|odd|even|green|0-36>.',
    bet: '🎡 /bet <amount> <red|black|odd|even|green|0-36> — European roulette.',
    slots: '🎰 /slots <amount> — 3 reels, pairs pay, triple 7s hit the jackpot.',
    blackjack: '🃏 Blackjack uses /bj <amount> to deal, then /bj hit, /bj stand, or /bj double.',
    bj: '🃏 /bj <amount> to deal, then /bj hit, /bj stand, or /bj double.',
    crash: '🚀 /crash <amount> <cashoutAt> — auto-cashout crash game.',
    duel: '⚔️ /duel <player> <amount> to challenge, then accept/decline and pick rock/paper/scissors.',
    race: '🏁 /race <amount> — enter the shared weighted race pot.',
  };

  if (game !== '?' && gameHelp[game]) {
    await pog.pm(gameHelp[game]);
    return;
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

  await pog.pm([
    '🎰 Casino games: ' + enabled.join(', '),
    `Min bet: ${config.minBet} | Base max bet: ${config.maxBet} | Window: ${config.capWindow}`,
    'Commands: /casinostats, /casinotop <wager|won|winrate|biggest>, /jackpot',
    'Tip: /casino <game> shows focused help for one game.',
  ].join('\n'));
}

await main();
