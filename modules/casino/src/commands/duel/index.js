import { data, takaro, TakaroUserError } from '@takaro/helpers';
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
  withCasinoLocks,
  ensureInteractivePlayAllowed,
} from './casino-helpers.js';

function beats(a, b) {
  return (a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper');
}

async function announce(gameServerId, ...messages) {
  const lines = messages.filter(Boolean);
  for (const message of lines) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: {},
    });
  }
}

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = getDefaultConfig(mod.userConfig);
  const arg1 = String(args.arg1 ?? '').toLowerCase();

  if (['accept', 'decline', 'rock', 'paper', 'scissors'].includes(arg1)) {
    const found = await findDuelForPlayer(gameServerId, mod.moduleId, player.id);
    if (!found) throw new TakaroUserError('You are not part of an active duel.');
    const duel = found.duel;
    const duelScopes = ['duel-registry', `player:${found.challengerId}`, `player:${duel.opponentId}`];

    await withCasinoLocks(gameServerId, mod.moduleId, duelScopes, async () => {
      const current = await getDuel(gameServerId, mod.moduleId, found.challengerId);
      if (!current) throw new TakaroUserError('This duel is no longer active.');

      if (arg1 === 'decline') {
        if (player.id !== current.opponentId) throw new TakaroUserError('Only the challenged player can decline this duel.');
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: found.challengerId, amount: current.amount, config, skipLock: true });
        await deleteDuel(gameServerId, mod.moduleId, found.challengerId);
        await announce(
          gameServerId,
          `⚔️ ${current.opponentName} declined ${current.challengerName}'s duel. ${current.challengerName} was refunded ${formatCurrency(current.amount)} coin.`,
        );
        await pog.pm('⚔️ Duel declined. Challenger refunded.');
        return;
      }

      if (arg1 === 'accept') {
        if (player.id !== current.opponentId) throw new TakaroUserError('Only the challenged player can accept this duel.');
        if (current.state !== 'pending') throw new TakaroUserError('This duel is no longer pending.');
        await ensureInteractivePlayAllowed(gameServerId, mod.moduleId, pog, player, config, 'duel');
        await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'duel', amount: current.amount, skipLock: true });
        current.state = 'accepted';
        current.acceptedStakePlaced = true;
        current.startedAt = new Date().toISOString();
        await setDuel(gameServerId, mod.moduleId, found.challengerId, current);
        await announce(
          gameServerId,
          `⚔️ ${current.opponentName} accepted ${current.challengerName}'s duel for ${formatCurrency(current.amount)} coin. Both players: /duel rock, /duel paper, or /duel scissors within 3 minutes or the duel expires and both stakes are refunded.`,
        );
        await pog.pm('⚔️ Duel accepted. Both players: /duel rock, /duel paper, or /duel scissors within 3 minutes or the duel expires and both stakes are refunded.');
        return;
      }

      if (current.state !== 'accepted') throw new TakaroUserError('This duel is not ready for picks yet.');
      try {
        await ensureInteractivePlayAllowed(gameServerId, mod.moduleId, pog, player, config, 'duel');
      } catch (err) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: found.challengerId, amount: current.amount, config, skipLock: true });
        if (current.acceptedStakePlaced && current.opponentId) {
          await refund({ gameServerId, moduleId: mod.moduleId, playerId: current.opponentId, amount: current.amount, config, skipLock: true });
        }
        await deleteDuel(gameServerId, mod.moduleId, found.challengerId);
        throw new TakaroUserError('This duel was cancelled and all stakes were refunded because a player can no longer use casino games.');
      }
      if (player.id === found.challengerId) current.challengerPick = arg1;
      else if (player.id === current.opponentId) current.opponentPick = arg1;
      else throw new TakaroUserError('You are not part of this duel.');

      current.startedAt = new Date().toISOString();
      if (!current.challengerPick || !current.opponentPick) {
        await setDuel(gameServerId, mod.moduleId, found.challengerId, current);
        await announce(gameServerId, `⚔️ ${player.name} locked in their duel pick. Waiting for the other player...`);
        await pog.pm(`⚔️ Locked in ${arg1}. Waiting for the other player.`);
        return;
      }

      if (current.challengerPick === current.opponentPick) {
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: found.challengerId, amount: current.amount, config, skipLock: true });
        await refund({ gameServerId, moduleId: mod.moduleId, playerId: current.opponentId, amount: current.amount, config, skipLock: true });
        await deleteDuel(gameServerId, mod.moduleId, found.challengerId);
        await announce(gameServerId, `⚔️ Duel tie! ${current.challengerName} and ${current.opponentName} both picked ${current.challengerPick}. Both stakes were refunded.`);
        await pog.pm(`⚔️ Tie — both picked ${current.challengerPick}. Stakes refunded.`);
        return;
      }

      const challengerWins = beats(current.challengerPick, current.opponentPick);
      const winnerId = challengerWins ? found.challengerId : current.opponentId;
      const loserId = challengerWins ? current.opponentId : found.challengerId;
      const winnerName = challengerWins ? current.challengerName : current.opponentName;
      const loserName = challengerWins ? current.opponentName : current.challengerName;
      const payout = Math.round(current.amount * 2 * (1 - (config.houseEdgePct / 100)));

      await settle({ gameServerId, moduleId: mod.moduleId, player: { id: winnerId, name: winnerName }, config, game: 'duel', betAmount: current.amount, payout, skipLock: true });
      await settle({ gameServerId, moduleId: mod.moduleId, player: { id: loserId, name: loserName }, config, game: 'duel', betAmount: current.amount, payout: 0, skipLock: true });
      await deleteDuel(gameServerId, mod.moduleId, found.challengerId);

      await announce(
        gameServerId,
        `⚔️ Duel result: ${winnerName} beat ${loserName}! ${current.challengerName} played ${current.challengerPick}; ${current.opponentName} played ${current.opponentPick}. ${winnerName} won ${formatCurrency(payout)} coin.`,
      );
      await pog.pm(`⚔️ ${winnerName} wins! ${current.challengerName} played ${current.challengerPick}; ${current.opponentName} played ${current.opponentPick}.`);
    });
    return;
  }

  const targetName = String(args.arg1 ?? '').trim();
  const amount = parsePositiveNumberLike(args.arg2);
  if (!targetName || !amount) throw new TakaroUserError('Usage: /duel <player> <amount>');
  const target = await resolvePlayerByName(targetName, gameServerId);
  if (!target) throw new TakaroUserError(`Player "${targetName}" not found on this game server.`);
  if (target.playerId === player.id) throw new TakaroUserError('You cannot duel yourself.');

  await withCasinoLocks(gameServerId, mod.moduleId, ['duel-registry', `player:${player.id}`, `player:${target.playerId}`], async () => {
    const challengerExisting = await getDuel(gameServerId, mod.moduleId, player.id);
    if (challengerExisting) throw new TakaroUserError('You already have an open duel challenge.');

    const challengerInAnyDuel = await findDuelForPlayer(gameServerId, mod.moduleId, player.id);
    if (challengerInAnyDuel) throw new TakaroUserError('You are already involved in another duel. Finish or cancel it first.');

    const targetInAnyDuel = await findDuelForPlayer(gameServerId, mod.moduleId, target.playerId);
    if (targetInAnyDuel) {
      throw new TakaroUserError(`${target.player?.name ?? targetName} is already involved in another duel.`);
    }

    await placeBet({ gameServerId, moduleId: mod.moduleId, pog, player, config, game: 'duel', amount, skipLock: true });
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
  });

  const opponentName = target.player?.name ?? targetName;
  await announce(
    gameServerId,
    `⚔️ ${player.name} challenged ${opponentName} to a duel for ${formatCurrency(amount)} coin. ${opponentName}: use /duel accept or /duel decline within 60s.`,
  );
  await pog.pm(`⚔️ Challenged ${opponentName} for ${formatCurrency(amount)} coin. They have 60s to /duel accept or /duel decline.`);
}

await main();
