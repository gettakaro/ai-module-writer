import { data, TakaroUserError } from '@takaro/helpers';
import {
  getDefaultConfig,
  placeBet,
  settle,
  refund,
  resolvePlayerByName,
  getDuel,
  setDuel,
  deleteDuel,
  findDuelForPlayer,
  formatCurrency,
  parsePositiveNumberLike,
} from './casino-helpers.js';

function beats(a, b) {
  return (a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper');
}

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const arg1 = String(args.arg1 ?? '').toLowerCase();
  const arg2 = String(args.arg2 ?? '?');

  if (['accept', 'decline', 'rock', 'paper', 'scissors'].includes(arg1)) {
    const found = await findDuelForPlayer(gameServerId, mod.moduleId, player.id);
    if (!found) throw new TakaroUserError('You are not part of an active duel.');
    const duel = found.duel;

    if (arg1 === 'decline') {
      if (player.id !== duel.opponentId) throw new TakaroUserError('Only the challenged player can decline this duel.');
      await refund({ gameServerId, moduleId: mod.moduleId, playerId: found.challengerId, amount: duel.amount, config });
      await deleteDuel(gameServerId, mod.moduleId, found.challengerId);
      await pog.pm('⚔️ Duel declined. Challenger refunded.');
      return;
    }

    if (arg1 === 'accept') {
      if (player.id !== duel.opponentId) throw new TakaroUserError('Only the challenged player can accept this duel.');
      if (duel.state !== 'pending') throw new TakaroUserError('This duel is no longer pending.');
      await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'duel', amount: duel.amount });
      duel.state = 'accepted';
      duel.acceptedStakePlaced = true;
      duel.startedAt = new Date().toISOString();
      await setDuel(gameServerId, mod.moduleId, found.challengerId, duel);
      await pog.pm('⚔️ Duel accepted. Both players: /duel rock, /duel paper, or /duel scissors.');
      return;
    }

    if (duel.state !== 'accepted') throw new TakaroUserError('This duel is not ready for picks yet.');
    if (player.id === found.challengerId) duel.challengerPick = arg1;
    else if (player.id === duel.opponentId) duel.opponentPick = arg1;
    else throw new TakaroUserError('You are not part of this duel.');

    duel.startedAt = new Date().toISOString();
    if (!duel.challengerPick || !duel.opponentPick) {
      await setDuel(gameServerId, mod.moduleId, found.challengerId, duel);
      await pog.pm(`⚔️ Locked in ${arg1}. Waiting for the other player.`);
      return;
    }

    if (duel.challengerPick === duel.opponentPick) {
      await refund({ gameServerId, moduleId: mod.moduleId, playerId: found.challengerId, amount: duel.amount, config });
      await refund({ gameServerId, moduleId: mod.moduleId, playerId: duel.opponentId, amount: duel.amount, config });
      await deleteDuel(gameServerId, mod.moduleId, found.challengerId);
      await pog.pm(`⚔️ Tie — both picked ${duel.challengerPick}. Stakes refunded.`);
      return;
    }

    const challengerWins = beats(duel.challengerPick, duel.opponentPick);
    const winnerId = challengerWins ? found.challengerId : duel.opponentId;
    const loserId = challengerWins ? duel.opponentId : found.challengerId;
    const winner = winnerId === found.challengerId ? { id: found.challengerId, name: duel.challengerName } : { id: duel.opponentId, name: duel.opponentName };
    await settle({ gameServerId, moduleId: mod.moduleId, player: { id: winnerId, name: winner.name }, config, game: 'duel', betAmount: duel.amount, payout: Math.round(duel.amount * 2 * (1 - (config.houseEdgePct / 100))) });
    await settle({ gameServerId, moduleId: mod.moduleId, player: { id: loserId, name: loserId === found.challengerId ? duel.challengerName : duel.opponentName }, config, game: 'duel', betAmount: duel.amount, payout: 0 });
    await deleteDuel(gameServerId, mod.moduleId, found.challengerId);
    await pog.pm(`⚔️ ${winner.name} wins! ${duel.challengerName} played ${duel.challengerPick}; ${duel.opponentName} played ${duel.opponentPick}.`);
    return;
  }

  const targetName = String(args.arg1 ?? '').trim();
  const amount = parsePositiveNumberLike(args.arg2);
  if (!targetName || !amount) throw new TakaroUserError('Usage: /duel <player> <amount>');
  const existing = await getDuel(gameServerId, mod.moduleId, player.id);
  if (existing) throw new TakaroUserError('You already have an open duel challenge.');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player \"${targetName}\" not found on this game server.`);
  if (target.playerId === player.id) throw new TakaroUserError('You cannot duel yourself.');

  await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'duel', amount });
  await setDuel(gameServerId, mod.moduleId, player.id, {
    opponentId: target.playerId,
    opponentName: target.player?.name ?? targetName,
    challengerName: player.name,
    amount: Math.round(amount),
    state: 'pending',
    challengerPick: null,
    opponentPick: null,
    acceptedStakePlaced: false,
    startedAt: new Date().toISOString(),
  });
  await pog.pm(`⚔️ Challenged ${target.player?.name ?? targetName} for ${formatCurrency(amount)} coin. They have 60s to /duel accept or /duel decline.`);
}

await main();
