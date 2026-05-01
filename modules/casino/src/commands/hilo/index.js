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

  // ─── HILO GAME LOGIC ─────────────────────────────────────────────────────
  if (cfg.enableHilo === false) throw new TakaroUserError('HiLo is currently disabled.');

  const SESSION_KEY = `casino_session:${playerId}:hilo`;

  function buildDeck() {
    const deck = [];
    for (let suit = 0; suit < 4; suit++) for (let val = 1; val <= 13; val++) deck.push(val);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }
  function cardLabel(val) {
    if (val === 1) return 'A';
    if (val === 11) return 'J';
    if (val === 12) return 'Q';
    if (val === 13) return 'K';
    return String(val);
  }

  const { action } = data.arguments;
  const numericAmount = parseFloat(action);
  const isStart = !isNaN(numericAmount) && numericAmount > 0;
  const normalizedAction = action.toLowerCase().trim();

  const sessionVar = await getVar(SESSION_KEY);
  const session = sessionVar ? JSON.parse(sessionVar.value) : null;

  if (isStart) {
    if (session) throw new TakaroUserError('You already have an active HiLo session. Use /hilo higher, /hilo lower, or /hilo cashout.');
    const amount = Math.round(numericAmount);
    const { effectiveHouseEdge, windowKey } = await placeBet('hilo', amount);
    const deck = buildDeck();
    const currentCard = deck.pop();
    await setVar(SESSION_KEY, { stake: amount, multiplier: 1.0, currentCard, deck, windowKey, effectiveHouseEdge, startedAt: new Date().toISOString() });
    await pm(`HiLo: Starting card: ${cardLabel(currentCard)}. /hilo higher or /hilo lower (1.00x). Cashout anytime with /hilo cashout.`);

  } else if (normalizedAction === 'cashout') {
    if (!session) throw new TakaroUserError('No active HiLo session. Start one with /hilo <amount>.');
    const payout = Math.round(session.stake * session.multiplier);
    await settle('hilo', session.stake, payout, session.windowKey);
    await deleteVar(SESSION_KEY);
    const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
    const balance = pogRes.data.data.currency ?? '?';
    await pm(`HiLo: Cashed out at ${session.multiplier.toFixed(2)}x — won ${payout} coins. (Balance: ${balance})`);

  } else if (normalizedAction === 'higher' || normalizedAction === 'lower') {
    if (!session) throw new TakaroUserError('No active HiLo session. Start one with /hilo <amount>.');

    const deck = session.deck;
    if (deck.length === 0) {
      const payout = Math.round(session.stake * session.multiplier);
      await settle('hilo', session.stake, payout, session.windowKey);
      await deleteVar(SESSION_KEY);
      const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
      const balance = pogRes.data.data.currency ?? '?';
      await pm(`HiLo: Deck exhausted — auto-cashout at ${session.multiplier.toFixed(2)}x! Won ${payout} coins. (Balance: ${balance})`);
      return;
    }

    const nextCard = deck.pop();
    const prePopSize = deck.length + 1;
    const ref = session.currentCard;
    let countCorrect = 0;
    for (const c of deck) {
      if (normalizedAction === 'higher' && c > ref) countCorrect++;
      if (normalizedAction === 'lower' && c < ref) countCorrect++;
    }
    if (normalizedAction === 'higher' && nextCard > ref) countCorrect++;
    if (normalizedAction === 'lower' && nextCard < ref) countCorrect++;
    const p = prePopSize > 0 ? countCorrect / prePopSize : 0.5;
    const isCorrect = normalizedAction === 'higher' ? nextCard > ref : nextCard < ref;

    if (isCorrect) {
      const edge = session.effectiveHouseEdge / 100;
      const safeP = Math.max(p, 0.01);
      const newMultiplier = session.multiplier * ((1 - edge) / safeP);
      const updatedSession = { ...session, currentCard: nextCard, deck, multiplier: newMultiplier };

      if (deck.length === 0) {
        const payout = Math.round(session.stake * newMultiplier);
        await settle('hilo', session.stake, payout, session.windowKey);
        await deleteVar(SESSION_KEY);
        const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
        const balance = pogRes.data.data.currency ?? '?';
        await pm(`HiLo: ${cardLabel(nextCard)}! Deck cleared — auto-cashout at ${newMultiplier.toFixed(2)}x! Won ${payout} coins. (Balance: ${balance})`);
      } else {
        await setVar(SESSION_KEY, updatedSession);
        const cashoutAmount = Math.round(session.stake * newMultiplier);
        await pm(`HiLo: ${cardLabel(nextCard)}! Correct (${newMultiplier.toFixed(2)}x). /hilo higher or /hilo lower or /hilo cashout to lock in ${cashoutAmount} coins.`);
      }
    } else {
      await settle('hilo', session.stake, 0, session.windowKey);
      await deleteVar(SESSION_KEY);
      const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
      const balance = pogRes.data.data.currency ?? '?';
      await pm(`HiLo: ${cardLabel(nextCard)}. Wrong — lost ${session.stake} coins. (Balance: ${balance})`);
    }

  } else {
    throw new TakaroUserError('Use /hilo <amount> to start, or /hilo higher|lower|cashout to continue.');
  }
}
await main();
