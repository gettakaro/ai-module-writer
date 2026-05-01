import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
async function main() {
  const gameServerId = data.gameServerId;
  const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  const DUEL_PENDING_TIMEOUT_MS = 60 * 1000; // 60 seconds
  const DUEL_ACCEPTED_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
  const now = Date.now();

  async function broadcast(msg) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: msg });
  }

  // Paginate all variables for this server
  let page = 0;
  const pageSize = 100;

  while (true) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { gameServerId: [gameServerId] },
      limit: pageSize,
      page,
    });

    const batch = res.data.data;
    if (!batch.length) break;

    for (const v of batch) {
      try {
        // ── HiLo sessions ──────────────────────────────────────────────
        if (v.key.startsWith('casino_session:') && v.key.endsWith(':hilo')) {
          const session = JSON.parse(v.value);
          const age = now - new Date(session.startedAt).getTime();
          if (age > SESSION_TIMEOUT_MS) {
            // Refund
            const pId = v.playerId;
            if (pId) {
              await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pId, { currency: session.stake });
              // Rewind window
              if (session.windowKey) {
                const wRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${pId}:${session.windowKey}`], gameServerId: [gameServerId], playerId: [pId] }, limit: 1 });
                if (wRes.data.data.length) {
                  const wd = JSON.parse(wRes.data.data[0].value);
                  wd.wagered = Math.max(0, (wd.wagered || 0) - session.stake);
                  await takaro.variable.variableControllerUpdate(wRes.data.data[0].id, { value: JSON.stringify(wd) });
                }
              }
            }
            await takaro.variable.variableControllerDelete(v.id);
          }
        }

        // ── Blackjack sessions ─────────────────────────────────────────
        if (v.key.startsWith('casino_session:') && v.key.endsWith(':blackjack')) {
          const session = JSON.parse(v.value);
          const age = now - new Date(session.startedAt).getTime();
          if (age > SESSION_TIMEOUT_MS) {
            const pId = v.playerId;
            if (pId) {
              await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pId, { currency: session.stake });
              if (session.windowKey) {
                const wRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${pId}:${session.windowKey}`], gameServerId: [gameServerId], playerId: [pId] }, limit: 1 });
                if (wRes.data.data.length) {
                  const wd = JSON.parse(wRes.data.data[0].value);
                  wd.wagered = Math.max(0, (wd.wagered || 0) - session.stake);
                  await takaro.variable.variableControllerUpdate(wRes.data.data[0].id, { value: JSON.stringify(wd) });
                }
              }
            }
            await takaro.variable.variableControllerDelete(v.id);
          }
        }

        // ── Duel sessions ──────────────────────────────────────────────
        if (v.key.startsWith('casino_duel:')) {
          const duel = JSON.parse(v.value);
          const age = now - new Date(duel.startedAt).getTime();
          const challengerId = v.playerId;

          if (duel.state === 'pending' && age > DUEL_PENDING_TIMEOUT_MS) {
            // Refund challenger only
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
            await takaro.variable.variableControllerDelete(v.id);
          }

          else if (duel.state === 'accepted' && age > DUEL_ACCEPTED_TIMEOUT_MS) {
            // Refund both
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
            if (duel.opponentId) {
              await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, duel.opponentId, { currency: duel.amount });
              if (duel.opponentWindowKey) {
                const wRes = await takaro.variable.variableControllerSearch({ filters: { key: [`casino_window:${duel.opponentId}:${duel.opponentWindowKey}`], gameServerId: [gameServerId], playerId: [duel.opponentId] }, limit: 1 });
                if (wRes.data.data.length) {
                  const wd = JSON.parse(wRes.data.data[0].value);
                  wd.wagered = Math.max(0, (wd.wagered || 0) - duel.amount);
                  await takaro.variable.variableControllerUpdate(wRes.data.data[0].id, { value: JSON.stringify(wd) });
                }
              }
            }
            await takaro.variable.variableControllerDelete(v.id);
          }
        }

      } catch (err) {
        // Non-blocking: skip malformed variables
      }
    }

    if (batch.length < pageSize) break;
    page++;
  }
}
await main();
