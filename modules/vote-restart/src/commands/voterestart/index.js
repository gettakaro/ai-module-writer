import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getVoteState,
  getRestartState,
  setVoteState,
  getCooldownUntil,
  deleteCooldown,
  getOnlineNonImmunePlayers,
  computeThreshold,
  withVoteLock,
} from './vote-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  // 1. Permission check
  if (!checkPermission(pog, 'VOTE_RESTART_INITIATE')) {
    throw new TakaroUserError('You do not have permission to start a restart vote.');
  }

  const { threshold, currentVotes, initiatorIsImmune, eligibleCount } = await withVoteLock(gameServerId, moduleId, async () => {
    const existingState = await getVoteState(gameServerId, moduleId);
    const restartState = await getRestartState(gameServerId, moduleId);
    if (existingState || restartState) {
      if (existingState?.status === 'passed' || restartState) {
        throw new TakaroUserError('A restart vote has already passed. Server restarting shortly.');
      }
      const elapsed = (Date.now() - new Date(existingState.startedAt).getTime()) / 1000;
      const remaining = Math.max(0, Math.ceil(config.voteDuration - elapsed));
      throw new TakaroUserError(
        `A restart vote is already in progress (started by ${existingState.initiatorName}). ${remaining}s remaining.`,
      );
    }

    const cooldownUntil = await getCooldownUntil(gameServerId, moduleId);
    if (cooldownUntil) {
      const cooldownMs = new Date(cooldownUntil).getTime() - Date.now();
      if (cooldownMs > 0) {
        const remainingSecs = Math.ceil(cooldownMs / 1000);
        throw new TakaroUserError(
          `A restart vote recently failed. Please wait ${remainingSecs}s before starting a new vote.`,
        );
      }
      await deleteCooldown(gameServerId, moduleId);
    }

    const eligiblePlayers = await getOnlineNonImmunePlayers(gameServerId);
    if (eligiblePlayers.length < config.minimumPlayers) {
      throw new TakaroUserError(
        `Not enough players to start a vote. Need at least ${config.minimumPlayers} non-immune players online (currently ${eligiblePlayers.length}).`,
      );
    }

    const initiatorIsImmune = Boolean(checkPermission(pog, 'VOTE_RESTART_IMMUNE'));
    const initialVoters = initiatorIsImmune ? [] : [pog.playerId];
    const threshold = computeThreshold(eligiblePlayers.length, config.passThreshold);
    const voteState = {
      startedAt: new Date().toISOString(),
      initiatorName: player.name,
      voters: initialVoters,
      status: 'active',
      requiredVotes: threshold,
      eligiblePlayerIds: eligiblePlayers.map((p) => p.playerId),
      eligibleCountAtStart: eligiblePlayers.length,
    };

    await setVoteState(gameServerId, moduleId, voteState);
    return { threshold, currentVotes: initialVoters.length, initiatorIsImmune, eligibleCount: eligiblePlayers.length };
  });

  console.log(
    `vote-restart: vote started by ${player.name}, eligible=${eligibleCount}, threshold=${threshold}, initiatorImmune=${initiatorIsImmune}`,
  );

  // 6. Broadcast
  const snapshotNote = initiatorIsImmune
    ? ` ${player.name}'s vote does not count, so the vote starts at 0.`
    : '';

  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `[Vote Restart] ${player.name} wants a restart. Type /voteyes to agree. ${currentVotes}/${threshold} yes votes so far, ${config.voteDuration}s left. Only the non-immune players who were online when the vote began can vote.${snapshotNote}`,
    opts: {},
  });
}

await main();
