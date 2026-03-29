import { data, takaro, checkPermission } from '@takaro/helpers';
import { getVariable, setVariable } from './economy-helpers.js';

const VARIABLE_KEY = 'lastZombieKillReward';

async function main() {
  const { gameServerId, module: mod } = data;

  const rewardPerKill = mod.userConfig.zombieKillReward;

  // Guard: non-positive reward is a misconfiguration — skip silently
  if (rewardPerKill <= 0) return;

  const lastRunVar = await getVariable(gameServerId, mod.moduleId, VARIABLE_KEY);

  // We last ran the rewards script at this time
  // If this is the first time we run it, just get the last 5 minutes
  const lastRun = lastRunVar
    ? new Date(JSON.parse(lastRunVar.value))
    : new Date(Date.now() - 5 * 60 * 1000);

  // Fetch all the kill events since the last time we gave out rewards
  const killEvents = (
    await takaro.event.eventControllerSearch({
      filters: { eventName: ['entity-killed'], gameserverId: [gameServerId] },
      greaterThan: { createdAt: lastRun.toISOString() },
      limit: 1000,
    })
  ).data.data;

  console.log(`Found ${killEvents.length} kill events since ${lastRun.toISOString()}`);

  if (killEvents.length >= 1000) {
    console.log('Warning: event limit reached, some kills may not be rewarded');
  }

  // Group the events by player
  const playerKills = {};
  for (const killEvent of killEvents) {
    if (!playerKills[killEvent.playerId]) {
      playerKills[killEvent.playerId] = [];
    }
    playerKills[killEvent.playerId].push(killEvent);
  }

  const playerEntries = Object.entries(playerKills);

  // Give each player their reward using allSettled so partial failures don't block others
  const results = await Promise.allSettled(
    playerEntries.map(async ([playerId, kills]) => {
      const pog = (
        await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId)
      ).data.data;
      const hasPermission = checkPermission(pog, 'ZOMBIE_KILL_REWARD_OVERRIDE');
      const defaultReward = rewardPerKill;

      // count=0 means admin intentionally disabled rewards for this player
      if (hasPermission && hasPermission.count === 0) {
        console.log(`Skipping reward for player ${playerId}: ZOMBIE_KILL_REWARD_OVERRIDE count=0`);
        return;
      }

      const reward = hasPermission && hasPermission.count != null ? hasPermission.count : defaultReward;
      const totalReward = reward * kills.length;
      return takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
        currency: totalReward,
      });
    }),
  );

  // Update timestamp UNCONDITIONALLY — prevents duplicate payouts which is worse than skipping failed ones
  await setVariable(gameServerId, mod.moduleId, VARIABLE_KEY, new Date());

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    playerEntries.forEach(([playerId], index) => {
      if (results[index].status === 'rejected') {
        console.error(`Failed to reward player ${playerId}: ${results[index].reason}`);
      }
    });
  }

  const successes = results.filter((r) => r.status === 'fulfilled').length;
  console.log(`Successfully rewarded ${successes} player(s), ${failures.length} failed`);
}

await main();
