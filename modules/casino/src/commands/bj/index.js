import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  // ─── LEDGER PRELUDE ──────────────────────────────────────────────────────
  const cfg = data.module.userConfig;
  const minBet = cfg.minBet ?? 1;
  const maxBet = cfg.maxBet ?? 1000;
  const houseEdgePct = cfg.houseEdgePct ?? 2;
  const jackpotContributionPct = cfg.jackpotContributionPct ?? 1;
  const cooldownSeconds = cfg.cooldownSeconds ?? 3;
  const bigWinThreshold = cfg.bigWinThreshold ?? 1000;
  const wagerCap = cfg.wagerCap ?? 0;
  const lossCap = cfg.lossCap ?? 0;
  const capWindow = cfg.capWindow ?? 'daily';
  const playerId = data.player.id;
  const gameServerId = data.gameServerId;
  const gameId = data.pog.gameId;

  function getCurrentWindowKey() {
    const now = new Date();
    if (capWindow === 'weekly') {
      const jan1 = new Date(now.getFullYear(), 0, 1);
      const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    return now.toISOString().slice(0, 10);
  }
  async function getVar(key) {
    const res = await takaro.variable.variableControllerSearch({ filters: { key: [key], gameServerId: [gameServerId], playerId: [playerId] }, limit: 1 });
    return res.data.data[0] ?? null;
  }
  async function getGlobalVar(key) {
    const res = await takaro.variable.variableControllerSearch({ filters: { key: [key], gameServerId: [gameServerId] }, limit: 1 });
    return res.data.data[0] ?? null;
  }
  async function setVar(key, value) {
    const existing = await getVar(key);
    if (existing) await takaro.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(value) });
    else await takaro.variable.variableControllerCreate({ key, value: JSON.stringify(value), gameServerId, playerId });
  }
  async function deleteVar(key) {
    const existing = await getVar(key);
    if (existing) await takaro.variable.variableControllerDelete(existing.id);
  }
  async function setGlobalVar(key, value) {
    const existing = await getGlobalVar(key);
    if (existing) await takaro.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(value) });
    else await takaro.variable.variableControllerCreate({ key, value: JSON.stringify(value), gameServerId });
  }
  async function pm(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId } } });
  }
  async function broadcast(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg });
  }

  async function placeBet(game, amount) {
    const banVar = await getVar(`casino_ban:${playerId}`);
    if (banVar) {
      const ban = JSON.parse(banVar.value);
      if (!ban.expiresAt || new Date(ban.expiresAt) > new Date()) throw new TakaroUserError('You are banned from the casino.');
    }
    if (!checkPermission(data.pog, 'CASINO_PLAY')) throw new TakaroUserError('You do not have permission to play casino games.');
    const vipPerm = checkPermission(data.pog, 'CASINO_VIP');
    const vipTier = vipPerm?.count ?? 0;
    const vipMultiplier = 1 + vipTier * 0.5;
    const effectiveHouseEdge = Math.max(0, houseEdgePct - vipTier * 0.5);
    if (amount < minBet) throw new TakaroUserError(`Minimum bet is ${minBet} coins.`);
    if (amount > maxBet * vipMultiplier) throw new TakaroUserError(`Maximum bet is ${Math.floor(maxBet * vipMultiplier)} coins.`);
    const cooldownVar = await getVar(`casino_cooldown:${playerId}`);
    if (cooldownVar) {
      const elapsed = (Date.now() - new Date(JSON.parse(cooldownVar.value)).getTime()) / 1000;
      if (elapsed < cooldownSeconds) throw new TakaroUserError(`Please wait ${Math.ceil(cooldownSeconds - elapsed)}s before betting again.`);
    }
    const windowKey = getCurrentWindowKey();
    const windowVarKey = `casino_window:${playerId}:${windowKey}`;
    const windowVar = await getVar(windowVarKey);
    const windowData = windowVar ? JSON.parse(windowVar.value) : { wagered: 0, lost: 0 };
    if (wagerCap > 0 && (windowData.wagered + amount) > wagerCap * vipMultiplier) throw new TakaroUserError(`You have reached your ${capWindow} wager cap.`);
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, playerId, { currency: amount });
    windowData.wagered += amount;
    await setVar(windowVarKey, windowData);
    await setVar(`casino_cooldown:${playerId}`, new Date().toISOString());
    return { vipTier, vipMultiplier, effectiveHouseEdge, windowKey };
  }

  async function settle(game, betAmount, payout, windowKey) {
    if (payout > 0) await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: Math.round(payout) });
    const net = payout - betAmount;
    if (net < 0) {
      const windowVarKey = `casino_window:${playerId}:${windowKey}`;
      const windowVar = await getVar(windowVarKey);
      const windowData = windowVar ? JSON.parse(windowVar.value) : { wagered: 0, lost: 0 };
      windowData.lost += Math.abs(net);
      await setVar(windowVarKey, windowData);
      if (lossCap > 0 && windowData.lost >= lossCap) await pm(`Warning: You have reached your ${capWindow} loss cap.`);
      const contribution = Math.abs(net) * jackpotContributionPct / 100;
      if (contribution > 0) {
        const jpVar = await getGlobalVar('casino_jackpot');
        const jp = jpVar ? JSON.parse(jpVar.value) : { amount: 0, lastWinner: null, lastWinAt: null, lastWinGame: null };
        jp.amount = (jp.amount || 0) + contribution;
        await setGlobalVar('casino_jackpot', jp);
      }
    }
    const statsKey = `casino_stats:${playerId}`;
    const statsVar = await getVar(statsKey);
    const stats = statsVar ? JSON.parse(statsVar.value) : { wagered: 0, won: 0, net: 0, gamesPlayed: 0, biggestWin: { amount: 0, game: null, at: null }, perGame: {} };
    stats.wagered = (stats.wagered || 0) + betAmount;
    stats.won = (stats.won || 0) + payout;
    stats.net = (stats.net || 0) + net;
    stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;
    if (!stats.perGame[game]) stats.perGame[game] = { wagered: 0, won: 0, plays: 0 };
    stats.perGame[game].wagered += betAmount;
    stats.perGame[game].won += payout;
    stats.perGame[game].plays += 1;
    if (net > 0 && net > (stats.biggestWin?.amount || 0)) stats.biggestWin = { amount: net, game, at: new Date().toISOString() };
    await setVar(statsKey, stats);
    if (net >= bigWinThreshold) await broadcast(`*** BIG WIN! ${data.player.name} won ${Math.round(net)} coins on ${game}! ***`);
    return { net };
  }

  // ─── BLACKJACK HELPERS ───────────────────────────────────────────────────
  if (cfg.enableBlackjack === false) throw new TakaroUserError('Blackjack is currently disabled.');

  const SUITS = ['S','H','D','C'];
  const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

  function buildDeck() {
    const deck = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }
  function cardValue(rank) {
    if (['J','Q','K'].includes(rank)) return 10;
    if (rank === 'A') return 11;
    return parseInt(rank, 10);
  }
  function handTotal(hand) {
    let total = 0, aces = 0;
    for (const card of hand) { total += cardValue(card.rank); if (card.rank === 'A') aces++; }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }
  function handStr(hand) { return hand.map(c => `${c.rank}${c.suit}`).join(' '); }

  const SESSION_KEY = `casino_session:${playerId}:blackjack`;
  const { action } = data.arguments;
  const numericAmount = parseFloat(action);
  const isStart = !isNaN(numericAmount) && numericAmount > 0;
  const normalizedAction = action.toLowerCase().trim();

  const sessionVar = await getVar(SESSION_KEY);
  const session = sessionVar ? JSON.parse(sessionVar.value) : null;

  if (isStart) {
    if (session) throw new TakaroUserError('You already have an active Blackjack session. Use /bj hit, /bj stand, or /bj double.');
    const amount = Math.round(numericAmount);
    const { effectiveHouseEdge, windowKey } = await placeBet('blackjack', amount);
    const deck = buildDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerUp = deck.pop();
    const dealerHole = deck.pop();
    const playerTotal = handTotal(playerHand);
    const dealerTotal = handTotal([dealerUp, dealerHole]);

    if (playerTotal === 21) {
      if (dealerTotal === 21) {
        await settle('blackjack', amount, amount, windowKey);
        await pm(`Blackjack: PUSH! Both have blackjack. Stake returned. Your hand: ${handStr(playerHand)} (21).`);
      } else {
        const edge = effectiveHouseEdge / 100;
        const payout = Math.round(amount * 2.5 * (1 - edge));
        await settle('blackjack', amount, payout, windowKey);
        const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
        const balance = pogRes.data.data.currency ?? '?';
        await pm(`Blackjack: BLACKJACK! Won ${payout} coins. (Balance: ${balance})`);
      }
      return;
    }

    await setVar(SESSION_KEY, { stake: amount, originalStake: amount, playerHand, dealerUp, dealerHole, deck, doubled: false, windowKey, effectiveHouseEdge, startedAt: new Date().toISOString() });
    await pm(`Blackjack: Your hand: ${handStr(playerHand)} (${playerTotal}). Dealer shows: ${dealerUp.rank}${dealerUp.suit}. /bj hit, /bj stand, /bj double`);

  } else if (normalizedAction === 'hit') {
    if (!session) throw new TakaroUserError('No active Blackjack session. Start one with /bj <amount>.');
    const card = session.deck.pop();
    session.playerHand.push(card);
    const total = handTotal(session.playerHand);
    if (total > 21) {
      await settle('blackjack', session.stake, 0, session.windowKey);
      await deleteVar(SESSION_KEY);
      const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
      const balance = pogRes.data.data.currency ?? '?';
      await pm(`Blackjack: BUST! ${handStr(session.playerHand)} (${total}). Lost ${session.stake} coins. (Balance: ${balance})`);
    } else if (total === 21) {
      await setVar(SESSION_KEY, session);
      await pm(`Blackjack: ${handStr(session.playerHand)} (21) — auto-standing. Use /bj stand.`);
    } else {
      await setVar(SESSION_KEY, session);
      await pm(`Blackjack: ${handStr(session.playerHand)} (${total}). Dealer shows: ${session.dealerUp.rank}${session.dealerUp.suit}. /bj hit, /bj stand`);
    }

  } else if (normalizedAction === 'double') {
    if (!session) throw new TakaroUserError('No active Blackjack session. Start one with /bj <amount>.');
    if (session.playerHand.length !== 2) throw new TakaroUserError('You can only double down on your first two cards.');
    await placeBet('blackjack', session.originalStake);
    const card = session.deck.pop();
    session.playerHand.push(card);
    session.stake = session.originalStake * 2;
    session.doubled = true;
    const total = handTotal(session.playerHand);
    if (total > 21) {
      await settle('blackjack', session.stake, 0, session.windowKey);
      await deleteVar(SESSION_KEY);
      const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
      const balance = pogRes.data.data.currency ?? '?';
      await pm(`Blackjack: Double Down BUST! ${handStr(session.playerHand)} (${total}). Lost ${session.stake} coins. (Balance: ${balance})`);
    } else {
      await setVar(SESSION_KEY, session);
      await pm(`Blackjack: Doubled down. ${handStr(session.playerHand)} (${total}). Dealer shows: ${session.dealerUp.rank}${session.dealerUp.suit}. Use /bj stand.`);
    }

  } else if (normalizedAction === 'stand') {
    if (!session) throw new TakaroUserError('No active Blackjack session. Start one with /bj <amount>.');
    const dealerHand = [session.dealerUp, session.dealerHole];
    let dealerTotal = handTotal(dealerHand);
    while (dealerTotal < 17) {
      const card = session.deck.pop();
      if (!card) break;
      dealerHand.push(card);
      dealerTotal = handTotal(dealerHand);
    }
    const playerTotal = handTotal(session.playerHand);
    const edge = session.effectiveHouseEdge / 100;
    let payout = 0;
    let resultMsg = '';
    if (dealerTotal > 21 || playerTotal > dealerTotal) {
      payout = Math.round(session.stake * 2 * (1 - edge));
      resultMsg = `WIN! Won ${payout} coins.`;
    } else if (playerTotal === dealerTotal) {
      payout = session.stake;
      resultMsg = `PUSH. Stake returned.`;
    } else {
      payout = 0;
      resultMsg = `LOSS. Lost ${session.stake} coins.`;
    }
    await settle('blackjack', session.stake, payout, session.windowKey);
    await deleteVar(SESSION_KEY);
    const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
    const balance = pogRes.data.data.currency ?? '?';
    await pm(`Blackjack: ${resultMsg}\nYour hand: ${handStr(session.playerHand)} (${playerTotal})\nDealer: ${handStr(dealerHand)} (${dealerTotal})\n(Balance: ${balance})`);

  } else {
    throw new TakaroUserError('Use /bj <amount> to deal, or /bj hit|stand|double to play.');
  }
}
await main();
