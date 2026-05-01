import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const cfg = data.module.userConfig;
  const houseEdgePct = cfg.houseEdgePct ?? 2;
  const jackpotContributionPct = cfg.jackpotContributionPct ?? 1;
  const bigWinThreshold = cfg.bigWinThreshold ?? 1000;
  const gameServerId = data.gameServerId;

  async function getGlobalVar(key) {
    const res = await takaro.variable.variableControllerSearch({ filters: { key: [key], gameServerId: [gameServerId] }, limit: 1 });
    return res.data.data[0] ?? null;
  }
  async function setGlobalVar(key, value) {
    const existing = await getGlobalVar(key);
    if (existing) await takaro.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(value) });
    else await takaro.variable.variableControllerCreate({ key, value: JSON.stringify(value), gameServerId });
  }
  async function deleteGlobalVar(key) {
    const existing = await getGlobalVar(key);
    if (existing) await takaro.variable.variableControllerDelete(existing.id);
  }
  async function broadcast(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg });
  }

  const poolVar = await getGlobalVar('casino_race_pool');
  if (!poolVar) return;

  const pool = JSON.parse(poolVar.value);
  if (!pool.drawAt || new Date(pool.drawAt) > new Date()) return; // Not yet time

  const participants = pool.participants || [];

  if (participants.length < 2) {
    // Refund all
    for (const p of participants) {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, p.playerId, { currency: p.amount });
      // Rewind window
      const windowVar = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${p.playerId}:${p.windowKey}`], gameServerId: [gameServerId], playerId: [p.playerId] }, limit: 1 });
      if (windowVar.data.data.length) {
        const wd = JSON.parse(windowVar.data.data[0].value);
        wd.wagered = Math.max(0, (wd.wagered || 0) - p.amount);
        await takaro.variable.variableControllerUpdate(windowVar.data.data[0].id, { value: JSON.stringify(wd) });
      }
    }
    if (participants.length > 0) {
      await broadcast('Race: Not enough participants (need at least 2). All bets refunded.');
    }
    await deleteGlobalVar('casino_race_pool');
    return;
  }

  // Weighted draw: weight = bet amount
  const totalPool = participants.reduce((sum, p) => sum + p.amount, 0);
  const edge = houseEdgePct / 100;
  const prizePool = Math.round(totalPool * (1 - edge));

  let rand = Math.random() * totalPool;
  let winner = participants[participants.length - 1];
  for (const p of participants) {
    rand -= p.amount;
    if (rand <= 0) { winner = p; break; }
  }

  // Pay winner
  await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, winner.playerId, { currency: prizePool });

  // Settle stats for winner
  const winnerStatsRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_stats:${winner.playerId}`], gameServerId: [gameServerId], playerId: [winner.playerId] }, limit: 1 });
  const winnerStats = winnerStatsRes.data.data[0] ? JSON.parse(winnerStatsRes.data.data[0].value) : { wagered: 0, won: 0, net: 0, gamesPlayed: 0, biggestWin: { amount: 0, game: null, at: null }, perGame: {} };
  const winnerNet = prizePool - winner.amount;
  winnerStats.wagered = (winnerStats.wagered || 0) + winner.amount;
  winnerStats.won = (winnerStats.won || 0) + prizePool;
  winnerStats.net = (winnerStats.net || 0) + winnerNet;
  winnerStats.gamesPlayed = (winnerStats.gamesPlayed || 0) + 1;
  if (!winnerStats.perGame.race) winnerStats.perGame.race = { wagered: 0, won: 0, plays: 0 };
  winnerStats.perGame.race.wagered += winner.amount;
  winnerStats.perGame.race.won += prizePool;
  winnerStats.perGame.race.plays += 1;
  if (winnerNet > 0 && winnerNet > (winnerStats.biggestWin?.amount || 0)) winnerStats.biggestWin = { amount: winnerNet, game: 'race', at: new Date().toISOString() };
  if (winnerStatsRes.data.data[0]) await takaro.variable.variableControllerUpdate(winnerStatsRes.data.data[0].id, { value: JSON.stringify(winnerStats) });
  else await takaro.variable.variableControllerCreate({ key: `casino_stats:${winner.playerId}`, value: JSON.stringify(winnerStats), gameServerId, playerId: winner.playerId });

  // Settle losers (stats + jackpot contribution)
  const losers = participants.filter(p => p.playerId !== winner.playerId);
  for (const p of losers) {
    const lossNet = -p.amount;
    const contribution = p.amount * jackpotContributionPct / 100;
    if (contribution > 0) {
      const jpVar = await getGlobalVar('casino_jackpot');
      const jp = jpVar ? JSON.parse(jpVar.value) : { amount: 0, lastWinner: null, lastWinAt: null, lastWinGame: null };
      jp.amount = (jp.amount || 0) + contribution;
      await setGlobalVar('casino_jackpot', jp);
    }
    const loserStatsRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_stats:${p.playerId}`], gameServerId: [gameServerId], playerId: [p.playerId] }, limit: 1 });
    const loserStats = loserStatsRes.data.data[0] ? JSON.parse(loserStatsRes.data.data[0].value) : { wagered: 0, won: 0, net: 0, gamesPlayed: 0, biggestWin: { amount: 0, game: null, at: null }, perGame: {} };
    loserStats.wagered = (loserStats.wagered || 0) + p.amount;
    loserStats.net = (loserStats.net || 0) + lossNet;
    loserStats.gamesPlayed = (loserStats.gamesPlayed || 0) + 1;
    if (!loserStats.perGame.race) loserStats.perGame.race = { wagered: 0, won: 0, plays: 0 };
    loserStats.perGame.race.wagered += p.amount;
    loserStats.perGame.race.plays += 1;
    if (loserStatsRes.data.data[0]) await takaro.variable.variableControllerUpdate(loserStatsRes.data.data[0].id, { value: JSON.stringify(loserStats) });
    else await takaro.variable.variableControllerCreate({ key: `casino_stats:${p.playerId}`, value: JSON.stringify(loserStats), gameServerId, playerId: p.playerId });
  }

  await broadcast(`Race: DRAW! ${winner.playerName} wins the race pool of ${prizePool} coins! (${participants.length} participants, ${totalPool} total wagered)`);
  if (winnerNet >= bigWinThreshold) {
    await broadcast(`*** BIG WIN! ${winner.playerName} won ${winnerNet} coins in the Race! ***`);
  }

  await deleteGlobalVar('casino_race_pool');
}
await main();
