import { data, TakaroUserError } from '@takaro/helpers';
import {
  getDefaultConfig,
  placeBet,
  settle,
  formatCurrency,
  KEY_BLACKJACK_SESSION,
  getPlayerSession,
  setPlayerSession,
  deletePlayerSession,
  createDeck,
  cardLabel,
  handTotal,
  isSoft17,
  parsePositiveNumberLike,
  refund,
  ensureInteractivePlayAllowed,
  withCasinoLocks,
} from './casino-helpers.js';

async function finishHand({ session, gameServerId, mod, player, pog, config }) {
  while (handTotal(session.dealerHand) < 17 || isSoft17(session.dealerHand)) {
    session.dealerHand.push(session.deck.pop());
  }
  const playerTotal = handTotal(session.playerHand);
  const dealerTotal = handTotal(session.dealerHand);
  let payout = 0;
  if (dealerTotal > 21 || playerTotal > dealerTotal) payout = Math.round(session.stake * 2 * (1 - (config.houseEdgePct / 100)));
  else if (playerTotal === dealerTotal) payout = session.stake;
  const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'blackjack', betAmount: session.stake, payout, skipLock: true });
  await deletePlayerSession(gameServerId, mod.moduleId, KEY_BLACKJACK_SESSION, player.id);
  const status = payout === 0 ? `Lost ${formatCurrency(session.stake)} coin.` : payout === session.stake ? 'Push — your stake was returned.' : `Won ${formatCurrency(payout)} coin.`;
  await pog.pm(`🃏 You: ${session.playerHand.map(cardLabel).join(' ')} (${playerTotal})\nDealer: ${session.dealerHand.map(cardLabel).join(' ')} (${dealerTotal})\n${status} (Balance: ${formatCurrency(result.balance)})`);
}

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const action = String(args.action ?? '').toLowerCase();

  await withCasinoLocks(gameServerId, mod.moduleId, [`player:${player.id}`], async () => {
    let session = await getPlayerSession(gameServerId, mod.moduleId, KEY_BLACKJACK_SESSION, player.id);

    const startAmount = parsePositiveNumberLike(action);
    if (startAmount) {
      if (session) throw new TakaroUserError('You are already in a blackjack hand. Use /bj hit, /bj stand, or /bj double.');
      const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'blackjack', amount: startAmount, skipLock: true });
      const deck = createDeck();
      session = {
        stake: placed.amount,
        playerHand: [deck.pop(), deck.pop()],
        dealerHand: [deck.pop(), deck.pop()],
        deck,
        startedAt: new Date().toISOString(),
        doubled: false,
      };

      const playerTotal = handTotal(session.playerHand);
      const dealerTotal = handTotal(session.dealerHand);
      if (playerTotal === 21) {
        const payout = dealerTotal === 21 ? session.stake : Math.round(session.stake * 2.5 * (1 - (config.houseEdgePct / 100)));
        const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'blackjack', betAmount: session.stake, payout, skipLock: true });
        await deletePlayerSession(gameServerId, mod.moduleId, KEY_BLACKJACK_SESSION, player.id);
        await pog.pm(`🃏 Blackjack! You: ${session.playerHand.map(cardLabel).join(' ')} | Dealer: ${session.dealerHand[0] ? cardLabel(session.dealerHand[0]) : '?'} ?\n${payout === session.stake ? 'Push.' : `Won ${formatCurrency(payout)} coin.`} (Balance: ${formatCurrency(result.balance)})`);
        return;
      }

      try {
        await setPlayerSession(gameServerId, mod.moduleId, KEY_BLACKJACK_SESSION, player.id, session);
      } catch (err) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: player.id, amount: session.stake, config, skipLock: true });
        throw new TakaroUserError('Your blackjack hand could not be started, so your stake was refunded. Please try again.');
      }
      await pog.pm(`🃏 Your hand: ${session.playerHand.map(cardLabel).join(' ')} (${playerTotal}). Dealer shows: ${cardLabel(session.dealerHand[0])}. /bj hit, /bj stand, /bj double`);
      return;
    }

    if (!session) throw new TakaroUserError('You have no active blackjack hand. Start with /bj <amount>.');

    try {
      await ensureInteractivePlayAllowed(gameServerId, mod.moduleId, pog, player, config, 'blackjack');
    } catch (err) {
      await refund({ gameServerId, moduleId: mod.moduleId, playerId: player.id, amount: session.stake, config, skipLock: true });
      await deletePlayerSession(gameServerId, mod.moduleId, KEY_BLACKJACK_SESSION, player.id);
      throw new TakaroUserError(`Your blackjack hand was cancelled and ${formatCurrency(session.stake)} coin was refunded because you can no longer play casino games.`);
    }

    if (action === 'hit') {
      session.playerHand.push(session.deck.pop());
      session.startedAt = new Date().toISOString();
      const total = handTotal(session.playerHand);
      if (total > 21) {
        const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'blackjack', betAmount: session.stake, payout: 0, skipLock: true });
        await deletePlayerSession(gameServerId, mod.moduleId, KEY_BLACKJACK_SESSION, player.id);
        await pog.pm(`🃏 Bust at ${total}. Lost ${formatCurrency(session.stake)} coin. (Balance: ${formatCurrency(result.balance)})`);
        return;
      }
      await setPlayerSession(gameServerId, mod.moduleId, KEY_BLACKJACK_SESSION, player.id, session);
      await pog.pm(`🃏 Your hand: ${session.playerHand.map(cardLabel).join(' ')} (${total}). Dealer shows: ${cardLabel(session.dealerHand[0])}. /bj hit, /bj stand${total === 21 ? ' — 21! Stand to resolve the hand.' : ''}`);
      return;
    }

    if (action === 'double') {
      if (session.playerHand.length !== 2) throw new TakaroUserError('You can only double on your first decision.');
      const extra = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'blackjack', amount: session.stake, skipLock: true });
      session.stake += extra.amount;
      session.doubled = true;
      session.playerHand.push(session.deck.pop());
      await finishHand({ session, gameServerId, mod, player, pog, config });
      return;
    }

    if (action !== 'stand') throw new TakaroUserError('Use /bj hit, /bj stand, or /bj double.');
    await finishHand({ session, gameServerId, mod, player, pog, config });
  });
}

await main();
