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

  async function settle(game, betAmount, payout, windowKey, jackpotWon) {
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
    if (jackpotWon) {
      const jpVar = await getGlobalVar('casino_jackpot');
      if (jpVar) {
        const jp = JSON.parse(jpVar.value);
        jp.lastWinner = data.player.name;
        jp.lastWinAt = new Date().toISOString();
        jp.lastWinGame = game;
        jp.amount = 0;
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
    if (net >= bigWinThreshold || jackpotWon) await broadcast(`*** ${jackpotWon ? 'JACKPOT' : 'BIG WIN'}! ${data.player.name} won ${Math.round(payout)} coins on ${game}! ***`);
    return { net };
  }

  // ─── SLOTS GAME LOGIC ────────────────────────────────────────────────────
  if (cfg.enableSlots === false) throw new TakaroUserError('Slots is currently disabled.');

  const SYMBOLS = [
    { name: 'Cherry',  weight: 30, tripleMultiplier: 3  },
    { name: 'Lemon',   weight: 20, tripleMultiplier: 5  },
    { name: 'Grape',   weight: 15, tripleMultiplier: 8  },
    { name: 'Bell',    weight: 10, tripleMultiplier: 15 },
    { name: 'Star',    weight: 5,  tripleMultiplier: 30 },
    { name: 'Diamond', weight: 2,  tripleMultiplier: 75 },
    { name: 'Seven',   weight: 1,  tripleMultiplier: 0  },
  ];
  const totalWeight = SYMBOLS.reduce((s, sym) => s + sym.weight, 0);

  function spinReel() {
    let rand = Math.random() * totalWeight;
    for (const sym of SYMBOLS) { rand -= sym.weight; if (rand <= 0) return sym; }
    return SYMBOLS[SYMBOLS.length - 1];
  }

  const { amount } = data.arguments;
  const { effectiveHouseEdge, windowKey } = await placeBet('slots', amount);
  const edge = effectiveHouseEdge / 100;
  const reels = [spinReel(), spinReel(), spinReel()];
  const display = reels.map(r => r.name).join(' | ');

  let payout = 0;
  let outcome = '';
  let jackpotWon = false;

  if (reels.every(r => r.name === 'Seven')) {
    const jpVar = await getGlobalVar('casino_jackpot');
    const jp = jpVar ? JSON.parse(jpVar.value) : { amount: 0 };
    payout = Math.max(jp.amount || 0, 0);
    outcome = `JACKPOT! Won ${Math.round(payout)} coins!`;
    jackpotWon = true;
  } else if (reels[0].name === reels[1].name && reels[1].name === reels[2].name) {
    payout = amount * reels[0].tripleMultiplier * (1 - edge);
    outcome = `Triple ${reels[0].name}! Won ${Math.round(payout)} coins.`;
  } else if (reels[0].name === reels[1].name || reels[1].name === reels[2].name) {
    payout = amount * 1.5 * (1 - edge);
    outcome = `Pair! Won ${Math.round(payout)} coins.`;
  } else {
    outcome = `No luck. Lost ${amount} coins.`;
  }

  await settle('slots', amount, payout, windowKey, jackpotWon);

  const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
  const balance = pogRes.data.data.currency ?? '?';
  await pm(`Slots: [ ${display} ] — ${outcome} (Balance: ${balance})`);
}
await main();
