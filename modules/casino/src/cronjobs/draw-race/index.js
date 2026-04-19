import { data, takaro } from '@takaro/helpers';
import { getDefaultConfig, mutateRacePool, pickWeightedWinner, settle, refund, formatCurrency } from './casino-helpers.js';

function emptyPool() {
  return {
    participants: [],
    drawAt: null,
    status: 'open',
  };
}

function getParticipantEntryKey(participant, index) {
  return participant?.ticketId ?? `${participant?.playerId ?? 'unknown'}:${index}`;
}

async function main() {
  const { gameServerId, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);

  let snapshot = await mutateRacePool(gameServerId, mod.moduleId, async (pool) => {
    const participants = Array.isArray(pool.participants) ? [...pool.participants] : [];
    const due = pool.drawAt && new Date(pool.drawAt).getTime() <= Date.now();
    const recoverableDrawing = pool.status === 'drawing' && participants.length > 0;
    const settledEntryKeys = new Set(Array.isArray(pool.settledEntryKeys) ? pool.settledEntryKeys : []);
    if (!recoverableDrawing && !due) {
      return undefined;
    }

    if (recoverableDrawing) {
      return {
        ...pool,
        participants,
        settledEntryKeys: [...settledEntryKeys],
      };
    }

    const totalPot = participants.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
    const cancelled = participants.length < 2;
    const winner = cancelled ? null : pickWeightedWinner(participants);
    const payout = cancelled ? 0 : Math.round(totalPot * (1 - (config.houseEdgePct / 100)));
    return {
      ...pool,
      participants,
      status: 'drawing',
      drawId: pool.drawId ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`,
      winnerId: winner?.playerId ?? null,
      winnerName: winner?.name ?? null,
      payout,
      totalPot,
      settledEntryKeys: Array.isArray(pool.settledEntryKeys) ? [...pool.settledEntryKeys] : [],
      cancelled,
    };
  });

  if (!snapshot) {
    console.log('casino.drawRace: nothing to draw');
    return;
  }

  try {
    const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];

    for (const [index, participant] of participants.entries()) {
      let shouldProcess = false;
      snapshot = await mutateRacePool(gameServerId, mod.moduleId, async (pool) => {
        const settled = new Set(Array.isArray(pool.settledEntryKeys) ? pool.settledEntryKeys : []);
        const entryKey = getParticipantEntryKey(participant, index);
        if (settled.has(entryKey)) return { ...pool, settledEntryKeys: [...settled] };
        settled.add(entryKey);
        shouldProcess = true;
        return {
          ...pool,
          settledEntryKeys: [...settled],
        };
      });

      if (!shouldProcess) continue;

      if (snapshot.cancelled) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: participant.playerId, amount: participant.amount, config });
      } else {
        const participantPayout = participant.playerId === snapshot.winnerId ? Number(snapshot.payout ?? 0) : 0;
        await settle({
          gameServerId,
          moduleId: mod.moduleId,
          player: { id: participant.playerId, name: participant.name },
          config,
          game: 'race',
          betAmount: participant.amount,
          payout: participantPayout,
        });
      }
    }

    if (snapshot.cancelled) {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `🏁 Race cancelled — only ${participants.length} ${participants.length === 1 ? 'entry was' : 'entries were'} in the pot, so everyone was refunded.`,
          opts: {},
        });
      } catch (err) {
        console.error(`casino.drawRace: failed to announce cancelled race: ${err}`);
      }
      console.log('casino.drawRace: refunded undersized race pool');
    } else {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `🏁 DRAW: ${participants.length} players, pot ${formatCurrency(snapshot.totalPot)} coin. Winner: ${snapshot.winnerName} (won ${formatCurrency(snapshot.payout)} coin)!`,
          opts: {},
        });
      } catch (err) {
        console.error(`casino.drawRace: failed to announce race winner: ${err}`);
      }
      console.log(`casino.drawRace: winner=${snapshot.winnerName} payout=${formatCurrency(snapshot.payout)} totalPot=${formatCurrency(snapshot.totalPot)}`);
    }

    await mutateRacePool(gameServerId, mod.moduleId, async () => emptyPool());
  } catch (err) {
    console.error(`casino.drawRace: draw failed, preserved pool progress for retry: ${err}`);
    throw err;
  }
}

await main();
