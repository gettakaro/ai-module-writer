import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getVoteState,
  setVoteState,
  getCooldownUntil,
  deleteCooldown,
  getOnlineNonImmunePlayers,
  computeThreshold,
} from './vote-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  // 1. Permission check
  if (!checkPermission(pog, 'VOTE_RESTART_INITIATE')) {
    throw new TakaroUserError('You do not have permission to start a restart vote.');
  }

  // 2. Check if vote already active or passed
  const existingState = await getVoteState(gameServerId, moduleId);
  if (existingState) {
    if (existingState.status === 'passed') {
      throw new TakaroUserError('A restart vote has already passed. Server restarting shortly.');
    }
    const elapsed = (Date.now() - new Date(existingState.startedAt).getTime()) / 1000;
    const remaining = Math.max(0, Math.ceil(config.voteDuration - elapsed));
    throw new TakaroUserError(
      `A restart vote is already in progress (started by ${existingState.initiatorName}). ${remaining}s remaining.`,
    );
  }

  // 3. Check cooldown
  const cooldownUntil = await getCooldownUntil(gameServerId, moduleId);
  if (cooldownUntil) {
    const cooldownMs = new Date(cooldownUntil).getTime() - Date.now();
    if (cooldownMs > 0) {
      const remainingSecs = Math.ceil(cooldownMs / 1000);
      throw new TakaroUserError(
        `A restart vote recently failed. Please wait ${remainingSecs}s before starting a new vote.`,
      );
    }
    // Cooldown expired — clean it up
    await deleteCooldown(gameServerId, moduleId);
  }

  // 4. Check minimum players
  const eligiblePlayers = await getOnlineNonImmunePlayers(gameServerId);
  if (eligiblePlayers.length < config.minimumPlayers) {
    throw new TakaroUserError(
      `Not enough players to start a vote. Need at least ${config.minimumPlayers} non-immune players online (currently ${eligiblePlayers.length}).`,
    );
  }

  // 5. Create vote state — initiator auto-voted if not immune
  const initiatorIsImmune = checkPermission(pog, 'VOTE_RESTART_IMMUNE');
  const initialVoters = initiatorIsImmune ? [] : [pog.playerId];

  const voteState = {
    startedAt: new Date().toISOString(),
    initiatorName: player.name,
    voters: initialVoters,
    status: 'active',
  };

  await setVoteState(gameServerId, moduleId, voteState);

  const threshold = computeThreshold(eligiblePlayers.length, config.passThreshold);
  const currentVotes = initialVoters.length;

  console.log(
    `vote-restart: vote started by ${player.name}, eligible=${eligiblePlayers.length}, threshold=${threshold}, initiatorImmune=${initiatorIsImmune}`,
  );

  // 6. Broadcast
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: `[Vote Restart] ${player.name} started a restart vote! /voteyes to agree. (${currentVotes}/${threshold}, ${config.voteDuration}s remaining)`,
    opts: {},
  });
}

await main();
