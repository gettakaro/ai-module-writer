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

  // ─── RACE GAME LOGIC ─────────────────────────────────────────────────────
  if (cfg.enableRace === false) throw new TakaroUserError('Race is currently disabled.');

  const { amount } = data.arguments;
  const { windowKey } = await placeBet('race', amount);

  const poolVar = await getGlobalVar('casino_race_pool');
  const pool = poolVar ? JSON.parse(poolVar.value) : { participants: [], drawAt: null };

  if (pool.participants.some(p => p.playerId === playerId)) {
    // Refund — already entered
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: amount });
    const windowVarKey = `casino_window:${playerId}:${windowKey}`;
    const windowVar = await getVar(windowVarKey);
    if (windowVar) {
      const wd = JSON.parse(windowVar.value);
      wd.wagered = Math.max(0, (wd.wagered || 0) - amount);
      await setVar(windowVarKey, wd);
    }
    throw new TakaroUserError('You are already entered in the current race pool.');
  }

  const now = new Date();
  if (!pool.drawAt || new Date(pool.drawAt) <= now) {
    pool.drawAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  }
  pool.participants.push({ playerId, playerName: data.player.name, amount, windowKey });
  await setGlobalVar('casino_race_pool', pool);

  const minutesLeft = Math.ceil((new Date(pool.drawAt) - now) / 60000);
  await pm(`Race: You entered with ${amount} coins! Draw in ~${minutesLeft} min. Participants: ${pool.participants.length}.`);
  await broadcast(`Race: ${data.player.name} joined the race pool (${amount} coins). ${pool.participants.length} participant(s). Draw in ~${minutesLeft} min!`);
}
await main();
