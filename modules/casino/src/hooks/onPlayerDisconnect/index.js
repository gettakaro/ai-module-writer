import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const playerId = data.player.id;

  async function getVar(key) {
    const res = await takaro.variable.variableControllerSearch({ filters: { key: [key], gameServerId: [gameServerId], playerId: [playerId] }, limit: 1 });
    return res.data.data[0] ?? null;
  }
  async function deleteVar(key) {
    const existing = await getVar(key);
    if (existing) await takaro.variable.variableControllerDelete(existing.id);
  }

  async function refundWindow(amount, windowKey) {
    if (!windowKey) return;
    const windowVarKey = `casino_window:${playerId}:${windowKey}`;
    const windowVar = await getVar(windowVarKey);
    if (windowVar) {
      const wd = JSON.parse(windowVar.value);
      wd.wagered = Math.max(0, (wd.wagered || 0) - amount);
      await takaro.variable.variableControllerUpdate(windowVar.id, { value: JSON.stringify(wd) });
    }
  }

  // ── HiLo session: refund ──────────────────────────────────────────────
  const hiloVar = await getVar(`casino_session:${playerId}:hilo`);
  if (hiloVar) {
    const session = JSON.parse(hiloVar.value);
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: session.stake });
    await refundWindow(session.stake, session.windowKey);
    await takaro.variable.variableControllerDelete(hiloVar.id);
  }

  // ── Blackjack session: refund ─────────────────────────────────────────
  const bjVar = await getVar(`casino_session:${playerId}:blackjack`);
  if (bjVar) {
    const session = JSON.parse(bjVar.value);
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: session.stake });
    await refundWindow(session.stake, session.windowKey);
    await takaro.variable.variableControllerDelete(bjVar.id);
  }

  // ── Crash session: no refund (loss on disconnect) ─────────────────────
  // Crash is instant — no stored session to clean up.

  // ── Duel: find if challenger or opponent ──────────────────────────────
  // As challenger
  const myDuelVar = await getVar(`casino_duel:${playerId}`);
  if (myDuelVar) {
    const duel = JSON.parse(myDuelVar.value);
    // Refund challenger
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: duel.amount });
    await refundWindow(duel.amount, duel.challengerWindowKey);
    // If accepted, also refund opponent
    if (duel.state === 'accepted' && duel.opponentId && duel.opponentWindowKey) {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, duel.opponentId, { currency: duel.amount });
      // Rewind opponent's window
      const oppWindowVarKey = `casino_window:${duel.opponentId}:${duel.opponentWindowKey}`;
      const oppWindowVar = await takaro.variable.variableControllerSearch({ filters: { key: [oppWindowVarKey], gameServerId: [gameServerId], playerId: [duel.opponentId] }, limit: 1 });
      if (oppWindowVar.data.data.length) {
        const wd = JSON.parse(oppWindowVar.data.data[0].value);
        wd.wagered = Math.max(0, (wd.wagered || 0) - duel.amount);
        await takaro.variable.variableControllerUpdate(oppWindowVar.data.data[0].id, { value: JSON.stringify(wd) });
      }
    }
    await takaro.variable.variableControllerDelete(myDuelVar.id);
  }

  // As opponent — find the challenger's duel variable
  const allDuelRes = await takaro.variable.variableControllerSearch({
    filters: { gameServerId: [gameServerId] },
    search: { key: ['casino_duel:'] },
    limit: 100,
  });

  const opponentDuelVar = allDuelRes.data.data.find(v => {
    if (!v.key.startsWith('casino_duel:')) return false;
    try {
      const d = JSON.parse(v.value);
      return d.opponentId === playerId;
    } catch { return false; }
  });

  if (opponentDuelVar && !myDuelVar) { // avoid double-processing if already handled above
    const duel = JSON.parse(opponentDuelVar.value);
    const challengerId = opponentDuelVar.playerId;
    // Refund opponent (disconnecting player)
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: duel.amount });
    if (duel.opponentWindowKey) {
      const wRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${playerId}:${duel.opponentWindowKey}`], gameServerId: [gameServerId], playerId: [playerId] }, limit: 1 });
      if (wRes.data.data.length) {
        const wd = JSON.parse(wRes.data.data[0].value);
        wd.wagered = Math.max(0, (wd.wagered || 0) - duel.amount);
        await takaro.variable.variableControllerUpdate(wRes.data.data[0].id, { value: JSON.stringify(wd) });
      }
    }
    // Refund challenger
    if (challengerId) {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, challengerId, { currency: duel.amount });
      if (duel.challengerWindowKey) {
        const wRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${challengerId}:${duel.challengerWindowKey}`], gameServerId: [gameServerId], playerId: [challengerId] }, limit: 1 });
        if (wRes.data.data.length) {
          const wd = JSON.parse(wRes.data.data[0].value);
          wd.wagered = Math.max(0, (wd.wagered || 0) - duel.amount);
          await takaro.variable.variableControllerUpdate(wRes.data.data[0].id, { value: JSON.stringify(wd) });
        }
      }
    }
    await takaro.variable.variableControllerDelete(opponentDuelVar.id);
  }
}
await main();
