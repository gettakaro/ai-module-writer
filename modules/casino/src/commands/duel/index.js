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

  async function getVarForPlayer(key, pid) {
    const res = await takaro.variable.variableControllerSearch({ filters: { key: [key], gameServerId: [gameServerId], playerId: [pid] }, limit: 1 });
    return res.data.data[0] ?? null;
  }
  async function getGlobalVar(key) {
    const res = await takaro.variable.variableControllerSearch({ filters: { key: [key], gameServerId: [gameServerId] }, limit: 1 });
    return res.data.data[0] ?? null;
  }
  async function setVarForPlayer(key, value, pid) {
    const existing = await getVarForPlayer(key, pid);
    if (existing) await takaro.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(value) });
    else await takaro.variable.variableControllerCreate({ key, value: JSON.stringify(value), gameServerId, playerId: pid });
  }
  async function setGlobalVar(key, value) {
    const existing = await getGlobalVar(key);
    if (existing) await takaro.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(value) });
    else await takaro.variable.variableControllerCreate({ key, value: JSON.stringify(value), gameServerId });
  }
  async function pm(msg, targetGameId) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg, opts: { recipient: { gameId: targetGameId || gameId } } });
  }
  async function broadcast(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg });
  }

  async function rewindWindow(pid, windowKey, amount) {
    if (!windowKey) return;
    const wRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${pid}:${windowKey}`], gameServerId: [gameServerId], playerId: [pid] }, limit: 1 });
    if (wRes.data.data.length) {
      const wd = JSON.parse(wRes.data.data[0].value);
      wd.wagered = Math.max(0, (wd.wagered || 0) - amount);
      await takaro.variable.variableControllerUpdate(wRes.data.data[0].id, { value: JSON.stringify(wd) });
    }
  }

  async function placeBetForPlayer(amount, pid, pog) {
    const banVar = await getVarForPlayer(`casino_ban:${pid}`, pid);
    if (banVar) {
      const ban = JSON.parse(banVar.value);
      if (!ban.expiresAt || new Date(ban.expiresAt) > new Date()) throw new TakaroUserError('A player in this duel is banned from the casino.');
    }
    if (!checkPermission(pog, 'CASINO_PLAY')) throw new TakaroUserError('A player does not have permission to play casino games.');
    const vipPerm = checkPermission(pog, 'CASINO_VIP');
    const vipTier = vipPerm?.count ?? 0;
    const vipMultiplier = 1 + vipTier * 0.5;
    const effectiveHouseEdge = Math.max(0, houseEdgePct - vipTier * 0.5);
    if (amount < minBet) throw new TakaroUserError(`Minimum bet is ${minBet} coins.`);
    if (amount > maxBet * vipMultiplier) throw new TakaroUserError(`Maximum bet is ${Math.floor(maxBet * vipMultiplier)} coins.`);
    const cooldownVar = await getVarForPlayer(`casino_cooldown:${pid}`, pid);
    if (cooldownVar) {
      const elapsed = (Date.now() - new Date(JSON.parse(cooldownVar.value)).getTime()) / 1000;
      if (elapsed < cooldownSeconds) throw new TakaroUserError(`Please wait ${Math.ceil(cooldownSeconds - elapsed)}s before betting again.`);
    }
    const windowKey = getCurrentWindowKey();
    const windowVarKey = `casino_window:${pid}:${windowKey}`;
    const windowVar = await getVarForPlayer(windowVarKey, pid);
    const windowData = windowVar ? JSON.parse(windowVar.value) : { wagered: 0, lost: 0 };
    if (wagerCap > 0 && (windowData.wagered + amount) > wagerCap * vipMultiplier) throw new TakaroUserError(`A player has reached their ${capWindow} wager cap.`);
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pid, { currency: amount });
    windowData.wagered += amount;
    await setVarForPlayer(windowVarKey, windowData, pid);
    await setVarForPlayer(`casino_cooldown:${pid}`, new Date().toISOString(), pid);
    return { effectiveHouseEdge, windowKey };
  }

  async function settleForPlayer(betAmount, payout, windowKey, pid, playerName) {
    if (payout > 0) await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pid, { currency: Math.round(payout) });
    const net = payout - betAmount;
    if (net < 0) {
      const wRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${pid}:${windowKey}`], gameServerId: [gameServerId], playerId: [pid] }, limit: 1 });
      if (wRes.data.data.length) {
        const wd = JSON.parse(wRes.data.data[0].value);
        wd.lost = (wd.lost || 0) + Math.abs(net);
        await takaro.variable.variableControllerUpdate(wRes.data.data[0].id, { value: JSON.stringify(wd) });
      }
      const contribution = Math.abs(net) * jackpotContributionPct / 100;
      if (contribution > 0) {
        const jpVar = await getGlobalVar('casino_jackpot');
        const jp = jpVar ? JSON.parse(jpVar.value) : { amount: 0, lastWinner: null, lastWinAt: null, lastWinGame: null };
        jp.amount = (jp.amount || 0) + contribution;
        await setGlobalVar('casino_jackpot', jp);
      }
    }
    const statsKey = `casino_stats:${pid}`;
    const statsVar = await getVarForPlayer(statsKey, pid);
    const stats = statsVar ? JSON.parse(statsVar.value) : { wagered: 0, won: 0, net: 0, gamesPlayed: 0, biggestWin: { amount: 0, game: null, at: null }, perGame: {} };
    stats.wagered = (stats.wagered || 0) + betAmount;
    stats.won = (stats.won || 0) + payout;
    stats.net = (stats.net || 0) + net;
    stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;
    if (!stats.perGame.duel) stats.perGame.duel = { wagered: 0, won: 0, plays: 0 };
    stats.perGame.duel.wagered += betAmount;
    stats.perGame.duel.won += payout;
    stats.perGame.duel.plays += 1;
    if (net > 0 && net > (stats.biggestWin?.amount || 0)) stats.biggestWin = { amount: net, game: 'duel', at: new Date().toISOString() };
    await setVarForPlayer(statsKey, stats, pid);
    if (net >= bigWinThreshold) await broadcast(`*** BIG WIN! ${playerName} won ${Math.round(net)} coins on duel! ***`);
    return { net };
  }

  async function refundForPlayer(amount, windowKey, pid) {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pid, { currency: amount });
    await rewindWindow(pid, windowKey, amount);
  }

  // ─── DUEL GAME LOGIC ─────────────────────────────────────────────────────
  if (cfg.enableDuel === false) throw new TakaroUserError('Duel is currently disabled.');

  const { action, amount } = data.arguments;
  const normalizedAction = (action || '').toLowerCase().trim();
  const PICKS = ['rock', 'paper', 'scissors'];

  // Fetch my duel (as challenger)
  const myDuelVarRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_duel:${playerId}`], gameServerId: [gameServerId], playerId: [playerId] }, limit: 1 });
  const myDuelVar = myDuelVarRes.data.data[0] ?? null;
  const myDuel = myDuelVar ? JSON.parse(myDuelVar.value) : null;

  // Fetch duel where I am the opponent
  const allDuelRes = await takaro.variable.variableControllerSearch({ filters: { gameServerId: [gameServerId] }, search: { key: ['casino_duel:'] }, limit: 100 });
  const opponentDuelVar = allDuelRes.data.data.find(v => {
    if (!v.key.startsWith('casino_duel:')) return false;
    try { const d = JSON.parse(v.value); return d.opponentId === playerId && (d.state === 'pending' || d.state === 'accepted'); } catch { return false; }
  }) ?? null;
  const opponentDuel = opponentDuelVar ? JSON.parse(opponentDuelVar.value) : null;

  // ── Challenge ─────────────────────────────────────────────────────────
  if (!PICKS.includes(normalizedAction) && normalizedAction !== 'accept' && normalizedAction !== 'decline') {
    if (!amount || amount <= 0) throw new TakaroUserError('Usage: /duel <playerName> <amount>');
    const targetName = action.trim();
    const playersRes = await takaro.player.playerControllerSearch({ filters: { name: [targetName] }, limit: 1 });
    if (!playersRes.data.data.length) throw new TakaroUserError(`Player "${targetName}" not found.`);
    const targetPlayer = playersRes.data.data[0];
    if (targetPlayer.id === playerId) throw new TakaroUserError('You cannot duel yourself.');
    if (myDuel && (myDuel.state === 'pending' || myDuel.state === 'accepted')) throw new TakaroUserError('You already have an active duel.');

    const { effectiveHouseEdge, windowKey } = await placeBetForPlayer(amount, playerId, data.pog);
    await setVarForPlayer(`casino_duel:${playerId}`, {
      opponentId: targetPlayer.id, opponentName: targetName, challengerName: data.player.name,
      amount, state: 'pending', challengerPick: null, opponentPick: null,
      challengerWindowKey: windowKey, opponentWindowKey: null,
      effectiveHouseEdge, startedAt: new Date().toISOString(),
    }, playerId);

    const opponentPogRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({ filters: { playerId: [targetPlayer.id], gameServerId: [gameServerId] }, limit: 1 });
    const opponentGameId = opponentPogRes.data.data[0]?.gameId;
    await pm(`Duel: You challenged ${targetName} for ${amount} coins!`);
    if (opponentGameId) await pm(`Duel: ${data.player.name} challenged you for ${amount} coins! /duel accept or /duel decline`, opponentGameId);
    return;
  }

  // ── Accept ────────────────────────────────────────────────────────────
  if (normalizedAction === 'accept') {
    if (!opponentDuelVar || !opponentDuel) throw new TakaroUserError('You have no pending duel challenge to accept.');
    if (opponentDuel.state !== 'pending') throw new TakaroUserError('This duel is no longer pending.');
    const { windowKey } = await placeBetForPlayer(opponentDuel.amount, playerId, data.pog);
    opponentDuel.state = 'accepted';
    opponentDuel.opponentWindowKey = windowKey;
    await takaro.variable.variableControllerUpdate(opponentDuelVar.id, { value: JSON.stringify(opponentDuel) });
    await pm(`Duel accepted! Pick: /duel rock, /duel paper, or /duel scissors.`);
    const challPogRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({ filters: { playerId: [opponentDuelVar.playerId], gameServerId: [gameServerId] }, limit: 1 });
    const challPog = challPogRes.data.data[0];
    if (challPog) await pm(`Duel: ${data.player.name} accepted! Pick: /duel rock, /duel paper, or /duel scissors.`, challPog.gameId);
    return;
  }

  // ── Decline ───────────────────────────────────────────────────────────
  if (normalizedAction === 'decline') {
    if (!opponentDuelVar || !opponentDuel) throw new TakaroUserError('You have no pending duel challenge to decline.');
    await refundForPlayer(opponentDuel.amount, opponentDuel.challengerWindowKey, opponentDuelVar.playerId);
    await takaro.variable.variableControllerDelete(opponentDuelVar.id);
    await pm(`Duel: You declined ${opponentDuel.challengerName}'s challenge. Bet refunded.`);
    const challPogRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({ filters: { playerId: [opponentDuelVar.playerId], gameServerId: [gameServerId] }, limit: 1 });
    const challPog = challPogRes.data.data[0];
    if (challPog) await pm(`Duel: ${data.player.name} declined your challenge. Bet refunded.`, challPog.gameId);
    return;
  }

  // ── Pick ──────────────────────────────────────────────────────────────
  if (PICKS.includes(normalizedAction)) {
    let activeDuel = null;
    let isChallenger = false;
    let duelVarRecord = null;

    if (myDuel && myDuel.state === 'accepted') {
      activeDuel = myDuel; isChallenger = true; duelVarRecord = myDuelVar;
    } else if (opponentDuelVar && opponentDuel && opponentDuel.state === 'accepted') {
      activeDuel = opponentDuel; isChallenger = false; duelVarRecord = opponentDuelVar;
    }
    if (!activeDuel) throw new TakaroUserError('No accepted duel found. Use /duel accept first.');

    if (isChallenger) {
      if (activeDuel.challengerPick) throw new TakaroUserError('You already made your pick.');
      activeDuel.challengerPick = normalizedAction;
    } else {
      if (activeDuel.opponentPick) throw new TakaroUserError('You already made your pick.');
      activeDuel.opponentPick = normalizedAction;
    }
    await takaro.variable.variableControllerUpdate(duelVarRecord.id, { value: JSON.stringify(activeDuel) });

    if (!activeDuel.challengerPick || !activeDuel.opponentPick) {
      await pm(`Duel: You picked ${normalizedAction}. Waiting for the other player...`);
      return;
    }

    // Both picked — resolve
    const cp = activeDuel.challengerPick;
    const op = activeDuel.opponentPick;
    const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const challengerId = duelVarRecord.playerId;
    const tie = cp === op;
    const edge = (activeDuel.effectiveHouseEdge ?? houseEdgePct) / 100;

    if (tie) {
      await refundForPlayer(activeDuel.amount, activeDuel.challengerWindowKey, challengerId);
      await refundForPlayer(activeDuel.amount, activeDuel.opponentWindowKey, activeDuel.opponentId);
      await broadcast(`Duel: ${activeDuel.challengerName} (${cp}) vs ${activeDuel.opponentName} (${op}) — TIE! Bets refunded.`);
    } else {
      const challengerWins = BEATS[cp] === op;
      const winnerName = challengerWins ? activeDuel.challengerName : activeDuel.opponentName;
      const payout = Math.round(activeDuel.amount * 2 * (1 - edge));
      await settleForPlayer(activeDuel.amount, challengerWins ? payout : 0, activeDuel.challengerWindowKey, challengerId, activeDuel.challengerName);
      await settleForPlayer(activeDuel.amount, challengerWins ? 0 : payout, activeDuel.opponentWindowKey, activeDuel.opponentId, activeDuel.opponentName);
      await broadcast(`Duel: ${activeDuel.challengerName} (${cp}) vs ${activeDuel.opponentName} (${op}) — ${winnerName} wins ${payout} coins!`);
    }
    await takaro.variable.variableControllerDelete(duelVarRecord.id);
    return;
  }

  throw new TakaroUserError('Usage: /duel <playerName> <amount> | accept | decline | rock | paper | scissors');
}
await main();
