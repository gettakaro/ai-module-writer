import { data, takaro, checkPermission } from '@takaro/helpers';
import { getAfkTracking, setAfkTracking } from './afk-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  let {
    checksBeforeWarning,
    checksBeforeKick,
    warningMessage,
    kickMessage,
    positionThreshold,
  } = mod.userConfig;

  if (checksBeforeKick <= checksBeforeWarning) {
    console.error(
      `AFK check: checksBeforeKick (${checksBeforeKick}) must be greater than checksBeforeWarning (${checksBeforeWarning}). Clamping checksBeforeKick to ${checksBeforeWarning + 1}.`,
    );
    checksBeforeKick = checksBeforeWarning + 1;
  }

  // Fetch ALL online players with positions and roles via pagination
  let allPlayers = [];
  let page = 0;
  const limit = 100;
  while (true) {
    if (page > 100) break;
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      page,
      limit,
    });
    const batch = res.data.data;
    allPlayers = allPlayers.concat(batch);
    if (allPlayers.length >= res.data.meta.total) break;
    page++;
  }

  console.log(`AFK check: found ${allPlayers.length} online players`);

  const tracking = await getAfkTracking(gameServerId, mod.moduleId);

  const onlineIds = new Set(allPlayers.map((pog) => pog.playerId));

  // Prune tracking map: remove entries for players who are no longer online
  for (const playerId of Object.keys(tracking)) {
    if (!onlineIds.has(playerId)) {
      delete tracking[playerId];
    }
  }

  for (const pog of allPlayers) {
    try {
      const playerId = pog.playerId;
      const x = pog.positionX;
      const y = pog.positionY;
      const z = pog.positionZ;

      if (
        x === undefined || x === null ||
        y === undefined || y === null ||
        z === undefined || z === null ||
        !isFinite(x) || !isFinite(y) || !isFinite(z)
      ) {
        console.log(`AFK check: skipping player ${playerId} — no valid position data`);
        continue;
      }

      const stored = tracking[playerId];

      if (!stored) {
        tracking[playerId] = { x, y, z, idleCount: 0, warned: false };
        console.log(`AFK check: player ${playerId} first seen, stored position`);
        continue;
      }

      const dx = x - stored.x;
      const dy = y - stored.y;
      const dz = z - stored.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (distance >= positionThreshold) {
        tracking[playerId] = { x, y, z, idleCount: 0, warned: false };
        continue;
      }

      stored.idleCount += 1;

      if (stored.idleCount >= checksBeforeKick) {
        if (checkPermission(pog, 'IMMUNE_TO_AFK_KICK')) {
          console.log(`AFK check: player ${playerId} is immune to AFK kick, skipping`);
          stored.idleCount = 0;
          continue;
        }
        await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, playerId, {
          reason: kickMessage,
        });
        delete tracking[playerId];
        console.log(`AFK check: kicked player ${playerId} for being AFK`);
      } else if (stored.idleCount >= checksBeforeWarning && !stored.warned) {
        if (checkPermission(pog, 'IMMUNE_TO_AFK_KICK')) {
          console.log(`AFK check: player ${playerId} is immune to AFK kick, skipping warning`);
          stored.idleCount = 0;
          continue;
        }
        if (!pog.gameId) {
          console.warn(`AFK check: player ${playerId} has no gameId, skipping PM but marking as warned`);
          stored.warned = true;
          continue;
        }
        try {
          await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
            message: warningMessage,
            opts: {
              recipient: {
                gameId: pog.gameId,
              },
            },
          });
        } catch (warnErr) {
          // Mark as warned even if the PM fails to prevent infinite re-warning
          stored.warned = true;
          console.error(`AFK check: failed to send warning PM to player ${playerId}`, warnErr);
          continue;
        }
        stored.warned = true;
        console.log(`AFK check: warned player ${playerId} for being AFK`);
      }
    } catch (err) {
      console.error('AFK check: error processing player', pog.playerId, err);
    }
  }

  await setAfkTracking(gameServerId, mod.moduleId, tracking);
  console.log(`AFK check: tracking state saved`);
}

await main();
