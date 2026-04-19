import { data, TakaroUserError } from '@takaro/helpers';
import {
  getDefaultConfig,
  placeBet,
  settle,
  refund,
  formatCurrency,
  roundCurrency,
  createDeck,
  cardLabel,
  KEY_HILO_SESSION,
  getPlayerSession,
  setPlayerSession,
  deletePlayerSession,
  parsePositiveNumberLike,
  ensureInteractivePlayAllowed,
} from './casino-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const action = String(args.action ?? '').toLowerCase();
  const existing = await getPlayerSession(gameServerId, mod.moduleId, KEY_HILO_SESSION, player.id);

  const startAmount = parsePositiveNumberLike(action);
  if (startAmount) {
    if (existing) {
      throw new TakaroUserError('You already have an active hilo streak. Use /hilo higher, /hilo lower, or /hilo cashout.');
    }
    const placed = await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'hilo', amount: startAmount });
    const deck = createDeck();
    const currentCard = deck.pop();
    await setPlayerSession(gameServerId, mod.moduleId, KEY_HILO_SESSION, player.id, {
      stake: placed.amount,
      multiplier: 1,
      currentCard,
      deck,
      startedAt: new Date().toISOString(),
    });
    await pog.pm(`🎴 Starting card: ${cardLabel(currentCard)}. /hilo higher or /hilo lower (1.00x).`);
    return;
  }

  if (!existing) {
    throw new TakaroUserError('You have no active hilo streak. Start with /hilo <amount>.');
  }

  try {
    await ensureInteractivePlayAllowed(gameServerId, mod.moduleId, pog, player, config, 'hilo');
  } catch (err) {
    await refund({ gameServerId, moduleId: mod.moduleId, playerId: player.id, amount: existing.stake, config });
    await deletePlayerSession(gameServerId, mod.moduleId, KEY_HILO_SESSION, player.id);
    throw new TakaroUserError(`Your hilo streak was cancelled and ${formatCurrency(existing.stake)} coin was refunded because you can no longer play casino games.`);
  }

  if (action === 'cashout') {
    const payout = roundCurrency(existing.stake * existing.multiplier);
    const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'hilo', betAmount: existing.stake, payout });
    await deletePlayerSession(gameServerId, mod.moduleId, KEY_HILO_SESSION, player.id);
    await pog.pm(`🎴 Cashed out at ${existing.multiplier.toFixed(2)}x — won ${formatCurrency(payout)} coin. (Balance: ${formatCurrency(result.balance)})`);
    return;
  }

  if (!['higher', 'lower'].includes(action)) {
    throw new TakaroUserError('Use /hilo higher, /hilo lower, or /hilo cashout.');
  }

  const nextCard = existing.deck.pop();
  if (!nextCard) {
    const payout = roundCurrency(existing.stake * existing.multiplier);
    const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'hilo', betAmount: existing.stake, payout });
    await deletePlayerSession(gameServerId, mod.moduleId, KEY_HILO_SESSION, player.id);
    await pog.pm(`🎴 Deck cleared! Auto-cashed out ${formatCurrency(payout)} coin. (Balance: ${formatCurrency(result.balance)})`);
    return;
  }

  const remainingBeforeDraw = [...existing.deck, nextCard];
  const correctCount = remainingBeforeDraw.filter((card) => action === 'higher' ? card.rank > existing.currentCard.rank : card.rank < existing.currentCard.rank).length;
  const probability = Math.max(1 / remainingBeforeDraw.length, correctCount / remainingBeforeDraw.length);
  const correct = action === 'higher' ? nextCard.rank > existing.currentCard.rank : nextCard.rank < existing.currentCard.rank;

  if (!correct) {
    const result = await settle({ gameServerId, moduleId: mod.moduleId, player, config, game: 'hilo', betAmount: existing.stake, payout: 0 });
    await deletePlayerSession(gameServerId, mod.moduleId, KEY_HILO_SESSION, player.id);
    await pog.pm(`🎴 ${cardLabel(nextCard)}. Wrong — lost ${formatCurrency(existing.stake)} coin. (Balance: ${formatCurrency(result.balance)})`);
    return;
  }

  existing.currentCard = nextCard;
  existing.multiplier = Number((existing.multiplier * ((1 - (config.houseEdgePct / 100)) / probability)).toFixed(2));
  existing.startedAt = new Date().toISOString();
  await setPlayerSession(gameServerId, mod.moduleId, KEY_HILO_SESSION, player.id, existing);
  await pog.pm(`🎴 ${cardLabel(nextCard)}! Correct (${existing.multiplier.toFixed(2)}x). /hilo higher, /hilo lower, or /hilo cashout to lock in ${formatCurrency(existing.stake * existing.multiplier)} coin.`);
}

await main();
