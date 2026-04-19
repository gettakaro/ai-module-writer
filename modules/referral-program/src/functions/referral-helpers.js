import { takaro, checkPermission, TakaroUserError } from '@takaro/helpers';

export function requireCommandPermission(pog, permission, message) {
  if (!checkPermission(pog, permission)) {
    throw new TakaroUserError(message);
  }
}

export const REFERRAL_CODE_PREFIX = 'referral_code:';
export const REFERRAL_CODE_LOOKUP_PREFIX = 'referral_code_lookup:';
export const REFERRAL_LINK_PREFIX = 'referral_link:';
export const REFERRAL_STATS_PREFIX = 'referral_stats:';
export const REFERRAL_PENDING_INDEX_KEY = 'referral_pending_index';
export const REFERRAL_STATS_INDEX_KEY = 'referral_stats_index';
export const REFERRAL_PAYOUT_LOCK_PREFIX = 'referral_payout_lock:';
export const REFERRAL_MUTATION_LOCK_PREFIX = 'referral_lock:';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function getReferralCodeKey(playerId) {
  return `${REFERRAL_CODE_PREFIX}${playerId}`;
}

export function getReferralCodeLookupKey(code) {
  return `${REFERRAL_CODE_LOOKUP_PREFIX}${String(code || '').toUpperCase()}`;
}

export function getReferralLinkKey(playerId) {
  return `${REFERRAL_LINK_PREFIX}${playerId}`;
}

export function getReferralStatsKey(playerId) {
  return `${REFERRAL_STATS_PREFIX}${playerId}`;
}

export function getReferralPayoutLockKey(playerId) {
  return `${REFERRAL_PAYOUT_LOCK_PREFIX}${playerId}`;
}

export function getReferralMutationLockKey(scope) {
  return `${REFERRAL_MUTATION_LOCK_PREFIX}${scope}`;
}

export function defaultReferralStats() {
  return {
    referralsTotal: 0,
    referralsPaid: 0,
    referralsToday: 0,
    lastReferralDay: null,
    currencyEarned: 0,
    itemsEarned: 0,
  };
}

export async function findVariable(gameServerId, moduleId, key, playerId) {
  const filters = {
    key: [key],
    gameServerId: [gameServerId],
    moduleId: [moduleId],
  };
  if (playerId) filters.playerId = [playerId];

  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

export async function writeVariable(gameServerId, moduleId, key, value, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    const payload = {
      key,
      value: serialized,
      gameServerId,
      moduleId,
    };
    if (playerId) payload.playerId = playerId;
    await takaro.variable.variableControllerCreate(payload);
  }
}

export async function createVariable(gameServerId, moduleId, key, value, playerId) {
  const payload = {
    key,
    value: JSON.stringify(value),
    gameServerId,
    moduleId,
  };
  if (playerId) payload.playerId = playerId;
  await takaro.variable.variableControllerCreate(payload);
}

export async function deleteVariable(gameServerId, moduleId, key, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  if (existing) {
    await takaro.variable.variableControllerDelete(existing.id);
  }
}

function safeJsonParse(raw, fallback, label) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`referral-helpers: failed to parse ${label}: ${err}`);
    return fallback;
  }
}

function getErrorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function looksLikeDuplicateVariableError(err) {
  const message = getErrorMessage(err);
  return /duplicate|already exists|unique/i.test(message);
}

async function tryAcquireVariableLock(gameServerId, moduleId, key, ownerToken, label, staleMs = 5 * 60 * 1000) {
  const now = Date.now();
  const lockPayload = {
    ownerToken,
    acquiredAt: new Date(now).toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await createVariable(gameServerId, moduleId, key, lockPayload);
      return { acquired: true, key, ownerToken };
    } catch (err) {
      if (!looksLikeDuplicateVariableError(err)) throw err;

      const existing = await findVariable(gameServerId, moduleId, key);
      const parsed = safeJsonParse(existing?.value, null, label);
      const acquiredAtMs = new Date(parsed?.acquiredAt ?? 0).getTime();
      const isStale = Number.isFinite(acquiredAtMs) && (now - acquiredAtMs) > staleMs;

      if (!existing || isStale) {
        await deleteVariable(gameServerId, moduleId, key);
        continue;
      }

      return { acquired: false, key, ownerToken, existing: parsed };
    }
  }

  return { acquired: false, key, ownerToken };
}

async function releaseVariableLock(gameServerId, moduleId, key, ownerToken, label) {
  const existing = await findVariable(gameServerId, moduleId, key);
  if (!existing) return;

  const parsed = safeJsonParse(existing.value, null, label);
  if (parsed?.ownerToken && parsed.ownerToken !== ownerToken) return;
  await takaro.variable.variableControllerDelete(existing.id);
}

export async function tryAcquirePayoutLock(gameServerId, moduleId, refereeId, ownerToken, staleMs = 5 * 60 * 1000) {
  return tryAcquireVariableLock(
    gameServerId,
    moduleId,
    getReferralPayoutLockKey(refereeId),
    ownerToken,
    `payout lock for ${refereeId}`,
    staleMs,
  );
}

export async function releasePayoutLock(gameServerId, moduleId, refereeId, ownerToken) {
  await releaseVariableLock(
    gameServerId,
    moduleId,
    getReferralPayoutLockKey(refereeId),
    ownerToken,
    `payout lock for ${refereeId}`,
  );
}

export async function withReferralLocks(gameServerId, moduleId, scopes, callback, options = {}) {
  const ownerToken = `${options.ownerTokenPrefix ?? 'lock'}:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;
  const uniqueScopes = Array.from(new Set((scopes || []).filter(Boolean))).sort();
  const acquiredLocks = [];
  const waitTimeoutMs = Math.max(0, Number(options.waitTimeoutMs ?? 2000) || 2000);
  const retryDelayMs = Math.max(10, Number(options.retryDelayMs ?? 50) || 50);

  try {
    for (const scope of uniqueScopes) {
      const key = getReferralMutationLockKey(scope);
      const startedAt = Date.now();
      let lock;

      do {
        lock = await tryAcquireVariableLock(
          gameServerId,
          moduleId,
          key,
          ownerToken,
          `mutation lock ${scope}`,
          options.staleMs,
        );

        if (lock.acquired) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } while ((Date.now() - startedAt) < waitTimeoutMs);

      if (!lock?.acquired) {
        throw new TakaroUserError(options.busyMessage || 'Another referral update is already in progress. Please try again in a moment.');
      }

      acquiredLocks.push({ key, scope });
    }

    return await callback();
  } finally {
    await Promise.allSettled(
      acquiredLocks.map((lock) => releaseVariableLock(gameServerId, moduleId, lock.key, ownerToken, `mutation lock ${lock.scope}`)),
    );
  }
}

export async function getReferralCode(gameServerId, moduleId, playerId) {
  const variable = await findVariable(gameServerId, moduleId, getReferralCodeKey(playerId), playerId);
  if (!variable) return null;
  return safeJsonParse(variable.value, null, `referral code for ${playerId}`);
}

export async function getReferralCodeLookup(gameServerId, moduleId, code) {
  const variable = await findVariable(gameServerId, moduleId, getReferralCodeLookupKey(code));
  if (!variable) return null;
  return safeJsonParse(variable.value, null, `referral code lookup for ${code}`);
}

function makeCode() {
  let result = '';
  for (let i = 0; i < 6; i++) {
    const index = Math.floor(Math.random() * CODE_ALPHABET.length);
    result += CODE_ALPHABET[index];
  }
  return result;
}

export async function ensureReferralCode(gameServerId, moduleId, playerId) {
  const existing = await getReferralCode(gameServerId, moduleId, playerId);
  if (existing?.code) {
    const lookupKey = getReferralCodeLookupKey(existing.code);
    const lookup = await findVariable(gameServerId, moduleId, lookupKey);
    if (!lookup) {
      try {
        await createVariable(gameServerId, moduleId, lookupKey, { playerId });
      } catch (err) {
        if (!looksLikeDuplicateVariableError(err)) throw err;
      }
    }
    return existing;
  }

  for (let attempt = 0; attempt < 25; attempt++) {
    const code = makeCode();
    const payload = { code, createdAt: new Date().toISOString() };
    const lookupKey = getReferralCodeLookupKey(code);

    try {
      await createVariable(gameServerId, moduleId, lookupKey, { playerId });
    } catch (err) {
      if (looksLikeDuplicateVariableError(err)) continue;
      throw err;
    }

    try {
      await createVariable(gameServerId, moduleId, getReferralCodeKey(playerId), payload, playerId);
      return payload;
    } catch (err) {
      if (looksLikeDuplicateVariableError(err)) {
        const settled = await getReferralCode(gameServerId, moduleId, playerId);
        if (settled?.code) {
          if (settled.code !== code) {
            await deleteVariable(gameServerId, moduleId, lookupKey);
          }
          return settled;
        }
      }

      await deleteVariable(gameServerId, moduleId, lookupKey);
      throw err;
    }
  }

  throw new Error('Failed to generate a unique referral code after 25 attempts.');
}

export async function getReferralLink(gameServerId, moduleId, refereePlayerId) {
  const variable = await findVariable(gameServerId, moduleId, getReferralLinkKey(refereePlayerId), refereePlayerId);
  if (!variable) return null;
  return safeJsonParse(variable.value, null, `referral link for ${refereePlayerId}`);
}

export async function setReferralLink(gameServerId, moduleId, refereePlayerId, link) {
  await writeVariable(gameServerId, moduleId, getReferralLinkKey(refereePlayerId), link, refereePlayerId);
}

export async function deleteReferralLink(gameServerId, moduleId, refereePlayerId) {
  await deleteVariable(gameServerId, moduleId, getReferralLinkKey(refereePlayerId), refereePlayerId);
}

export async function getReferralStats(gameServerId, moduleId, playerId) {
  const variable = await findVariable(gameServerId, moduleId, getReferralStatsKey(playerId), playerId);
  if (!variable) return defaultReferralStats();
  const parsed = safeJsonParse(variable.value, defaultReferralStats(), `referral stats for ${playerId}`);
  return { ...defaultReferralStats(), ...parsed };
}

export async function setReferralStats(gameServerId, moduleId, playerId, stats) {
  await writeVariable(gameServerId, moduleId, getReferralStatsKey(playerId), { ...defaultReferralStats(), ...stats }, playerId);
  await addToStringIndex(gameServerId, moduleId, REFERRAL_STATS_INDEX_KEY, playerId);
}

export async function getStringIndex(gameServerId, moduleId, key) {
  const variable = await findVariable(gameServerId, moduleId, key);
  if (!variable) return [];
  const parsed = safeJsonParse(variable.value, [], `index ${key}`);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value) => typeof value === 'string');
}

export async function setStringIndex(gameServerId, moduleId, key, values) {
  const unique = Array.from(new Set(values.filter((value) => typeof value === 'string')));
  await writeVariable(gameServerId, moduleId, key, unique);
}

async function mutateStringIndex(gameServerId, moduleId, key, mutator) {
  return withReferralLocks(
    gameServerId,
    moduleId,
    [`index:${key}`],
    async () => {
      const current = await getStringIndex(gameServerId, moduleId, key);
      const next = mutator(Array.from(current));
      await setStringIndex(gameServerId, moduleId, key, next);
      return next;
    },
    {
      ownerTokenPrefix: `index:${key}`,
      busyMessage: 'Another referral update is already in progress. Please try again in a moment.',
    },
  );
}

export async function addToStringIndex(gameServerId, moduleId, key, value) {
  await mutateStringIndex(gameServerId, moduleId, key, (current) => (
    current.includes(value) ? current : [...current, value]
  ));
}

export async function removeFromStringIndex(gameServerId, moduleId, key, value) {
  await mutateStringIndex(gameServerId, moduleId, key, (current) => current.filter((entry) => entry !== value));
}

export async function getPendingRefereeIds(gameServerId, moduleId) {
  return getStringIndex(gameServerId, moduleId, REFERRAL_PENDING_INDEX_KEY);
}

export async function addPendingReferee(gameServerId, moduleId, refereePlayerId) {
  await addToStringIndex(gameServerId, moduleId, REFERRAL_PENDING_INDEX_KEY, refereePlayerId);
}

export async function removePendingReferee(gameServerId, moduleId, refereePlayerId) {
  await removeFromStringIndex(gameServerId, moduleId, REFERRAL_PENDING_INDEX_KEY, refereePlayerId);
}

export async function listStatsEntries(gameServerId, moduleId) {
  const playerIds = await getStringIndex(gameServerId, moduleId, REFERRAL_STATS_INDEX_KEY);
  const entries = [];
  for (const playerId of playerIds) {
    const stats = await getReferralStats(gameServerId, moduleId, playerId);
    entries.push({ playerId, stats });
  }
  return entries;
}

export async function findPlayerByName(gameServerId, name) {
  const targetName = String(name || '').trim();
  if (!targetName) return null;

  const result = await takaro.player.playerControllerSearch({
    search: { name: [targetName] },
    limit: 25,
  });

  const exactMatches = result.data.data.filter((player) => player.name.toLowerCase() === targetName.toLowerCase());
  if (!exactMatches.length) return null;

  const pogSearch = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      playerId: exactMatches.map((player) => player.id),
    },
    limit: exactMatches.length,
  });

  const playerIdsOnServer = new Set(pogSearch.data.data.map((pog) => pog.playerId));
  return exactMatches.find((player) => playerIdsOnServer.has(player.id)) ?? null;
}

export async function getPlayerName(playerId) {
  try {
    const result = await takaro.player.playerControllerGetOne(playerId);
    return result.data.data?.name ?? playerId;
  } catch (err) {
    console.error(`referral-helpers: failed to get player name for ${playerId}: ${err}`);
    return playerId;
  }
}

export async function getPog(gameServerId, playerId) {
  const result = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      playerId: [playerId],
    },
    limit: 1,
  });

  return result.data.data[0] ?? null;
}

export function getPlaytimeMinutes(pog) {
  const seconds = Number(pog?.playtimeSeconds ?? 0);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return seconds / 60;
}

export function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function resetDailyCounterIfNeeded(stats, today = getTodayKey()) {
  if (stats.lastReferralDay !== today) {
    return {
      ...stats,
      referralsToday: 0,
    };
  }
  return stats;
}

export function getVipMultiplier(pog) {
  const permission = pog ? checkPermission(pog, 'REFERRAL_VIP') : null;
  const tier = Math.max(0, Math.min(Number(permission?.count ?? 0) || 0, 5));
  return {
    tier,
    multiplier: 1 + (tier * 0.05),
  };
}

export async function changeCurrency(gameServerId, playerId, amount) {
  const normalized = Math.trunc(Number(amount) || 0);
  if (!normalized) return 0;

  if (normalized > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
      currency: normalized,
    });
    return normalized;
  }

  const pog = await getPog(gameServerId, playerId);
  const currentCurrency = Math.max(0, Math.floor(Number(pog?.currency) || 0));
  const nextCurrency = Math.max(0, currentCurrency + normalized);
  await takaro.playerOnGameserver.playerOnGameServerControllerSetCurrency(gameServerId, playerId, {
    currency: nextCurrency,
  });
  return nextCurrency - currentCurrency;
}

export async function awardCurrency(gameServerId, playerId, amount) {
  if (!amount || amount <= 0) return 0;
  return changeCurrency(gameServerId, playerId, Math.floor(amount));
}

export function getNormalizedConfig(mod) {
  const config = mod.userConfig || {};
  return {
    prizeIsCurrency: config.prizeIsCurrency !== false,
    referrerCurrencyReward: Math.max(0, Number(config.referrerCurrencyReward ?? 500) || 0),
    refereeCurrencyReward: Math.max(0, Number(config.refereeCurrencyReward ?? 100) || 0),
    items: Array.isArray(config.items) ? config.items : [],
    playtimeThresholdMinutes: Math.max(1, Number(config.playtimeThresholdMinutes ?? 60) || 60),
    referralWindowHours: Math.max(0, Number(config.referralWindowHours ?? 24) || 0),
    maxReferralsPerDay: Math.max(1, Number(config.maxReferralsPerDay ?? 5) || 5),
    maxReferralsLifetime: Math.max(1, Number(config.maxReferralsLifetime ?? 50) || 50),
  };
}

export async function getCommandPrefix(gameServerId) {
  try {
    const result = await takaro.settings.settingsControllerGet(['commandPrefix'], gameServerId);
    return result.data.data?.[0]?.value || '/';
  } catch (err) {
    console.error(`referral-helpers: failed to load command prefix for ${gameServerId}: ${err}`);
    return '/';
  }
}

function normalizeConfiguredItem(item) {
  return {
    item: item?.item,
    amount: Math.max(1, Math.floor(Number(item?.amount) || 1)),
    quality: item?.quality,
  };
}

async function validateConfiguredItemExists(gameServerId, itemName) {
  const result = await takaro.item.itemControllerSearch({
    filters: {
      name: [itemName],
      gameserverId: [gameServerId],
    },
    limit: 1,
  });

  if (!result.data.data.length) {
    throw new TakaroUserError(`Configured referral reward item "${itemName}" was not found for this game server.`);
  }
}

function serializePreparedRewardFields(reward, multiplierInfo, reason, retries = 0) {
  return {
    rewardType: reward.rewardType,
    rewardAmount: reward.amount ?? 0,
    rewardItem: reward.item ?? null,
    rewardQuality: reward.quality ?? null,
    vipTier: multiplierInfo.tier,
    vipMultiplier: multiplierInfo.multiplier,
    payoutReason: reason,
    retries,
  };
}

function deserializePreparedReward(link) {
  if (link?.rewardType === 'currency') {
    return {
      rewardType: 'currency',
      amount: Math.max(0, Math.floor(Number(link.rewardAmount) || 0)),
    };
  }

  if (link?.rewardType === 'item') {
    return {
      rewardType: 'item',
      item: link.rewardItem,
      amount: Math.max(1, Math.floor(Number(link.rewardAmount) || 1)),
      quality: link.rewardQuality,
    };
  }

  return null;
}

function clearPreparedReward(link) {
  return {
    ...link,
    rewardType: undefined,
    rewardAmount: undefined,
    rewardItem: undefined,
    rewardQuality: undefined,
    vipTier: undefined,
    vipMultiplier: undefined,
    payoutPreparedAt: undefined,
    payoutReason: undefined,
    rewardGranted: undefined,
    rewardGrantedAt: undefined,
    paidAt: undefined,
    lastError: undefined,
    lastTriedAt: undefined,
  };
}

export async function planReferrerReward(gameServerId, referrerId, config, multiplierInfo) {
  if (config.prizeIsCurrency) {
    const amount = Math.max(0, Math.floor(config.referrerCurrencyReward * multiplierInfo.multiplier));
    return { rewardType: 'currency', amount };
  }

  if (!config.items.length) {
    throw new TakaroUserError('Referral rewards are configured for items, but no items are configured.');
  }

  const chosen = normalizeConfiguredItem(config.items[Math.floor(Math.random() * config.items.length)]);
  if (!chosen.item || !chosen.amount || !chosen.quality) {
    throw new TakaroUserError('A referral reward item is missing item, amount, or quality.');
  }

  await validateConfiguredItemExists(gameServerId, chosen.item);

  return {
    rewardType: 'item',
    item: chosen.item,
    amount: chosen.amount,
    quality: chosen.quality,
  };
}

export async function executePreparedReward(gameServerId, referrerId, reward) {
  if (reward.rewardType === 'currency') {
    await awardCurrency(gameServerId, referrerId, reward.amount ?? 0);
    return reward;
  }

  await takaro.gameserver.gameServerControllerGiveItem(gameServerId, referrerId, {
    name: reward.item,
    amount: reward.amount,
    quality: reward.quality,
  });

  return reward;
}

export async function awardReferrerReward(gameServerId, referrerId, config, multiplierInfo) {
  const reward = await planReferrerReward(gameServerId, referrerId, config, multiplierInfo);
  await executePreparedReward(gameServerId, referrerId, reward);
  return reward;
}

export async function awardWelcomeBonus(gameServerId, refereeId, config) {
  const amount = Math.max(0, Math.floor(config.refereeCurrencyReward));
  if (amount > 0) {
    await awardCurrency(gameServerId, refereeId, amount);
  }
  return amount;
}

export async function rollbackWelcomeBonus(gameServerId, refereeId, amount) {
  const normalized = Math.max(0, Math.floor(Number(amount) || 0));
  if (!normalized) return 0;

  const pog = await getPog(gameServerId, refereeId);
  const currentCurrency = Math.max(0, Math.floor(Number(pog?.currency) || 0));
  if (currentCurrency < normalized) return 0;

  return Math.abs(await changeCurrency(gameServerId, refereeId, -normalized));
}

export async function rollbackReferrerReward(gameServerId, referrerId, link) {
  if (!referrerId || !link || link.status !== 'paid') {
    return { rolledBack: false, skipped: true, reason: 'not-paid' };
  }

  const reward = deserializePreparedReward(link);
  if (!reward) {
    return { rolledBack: false, skipped: true, reason: 'missing-reward' };
  }

  if (reward.rewardType === 'currency') {
    const amount = Math.max(0, Math.floor(Number(reward.amount) || 0));
    const pog = await getPog(gameServerId, referrerId);
    const currentCurrency = Math.max(0, Math.floor(Number(pog?.currency) || 0));

    if (currentCurrency < amount) {
      return {
        rolledBack: false,
        skipped: true,
        rewardType: 'currency',
        amount,
        currentCurrency,
        fullRollback: false,
        reason: 'insufficient-currency-for-clawback',
      };
    }

    if (amount > 0) {
      await changeCurrency(gameServerId, referrerId, -amount);
    }

    return { rolledBack: amount > 0, rewardType: 'currency', amount, currentCurrency, fullRollback: true };
  }

  return {
    rolledBack: false,
    skipped: true,
    rewardType: 'item',
    amount: Math.max(1, Math.floor(Number(reward.amount) || 1)),
    item: reward.item,
    quality: reward.quality,
    reason: 'item-rewards-cannot-be-clawed-back-automatically',
  };
}

export async function adjustReferrerStatsForLink(gameServerId, moduleId, referrerId, link, direction = -1) {
  if (!referrerId || !link) return null;

  const stats = await getReferralStats(gameServerId, moduleId, referrerId);
  const normalizedDirection = direction >= 0 ? 1 : -1;
  const rewardAmount = Math.max(0, Math.floor(Number(link.rewardAmount) || 0));
  const linkedDay = typeof link.linkedAt === 'string' ? link.linkedAt.slice(0, 10) : null;

  const nextStats = {
    ...stats,
    referralsTotal: Math.max(0, stats.referralsTotal + (link.status === 'rejected' ? 0 : normalizedDirection)),
    referralsPaid: Math.max(0, stats.referralsPaid + (link.status === 'paid' ? normalizedDirection : 0)),
    referralsToday: Math.max(0, stats.referralsToday + (normalizedDirection < 0 && linkedDay && stats.lastReferralDay === linkedDay ? normalizedDirection : 0)),
    currencyEarned: Math.max(0, stats.currencyEarned + (link.status === 'paid' && link.rewardType === 'currency' ? normalizedDirection * rewardAmount : 0)),
    itemsEarned: Math.max(0, stats.itemsEarned + (link.status === 'paid' && link.rewardType === 'item' ? normalizedDirection * rewardAmount : 0)),
  };

  await setReferralStats(gameServerId, moduleId, referrerId, nextStats);
  return nextStats;
}

function describeReward(reward) {
  if (!reward) return 'a referral reward';
  if (reward.rewardType === 'currency') {
    return `${Math.max(0, Math.floor(Number(reward.amount) || 0))} currency`;
  }
  return `${Math.max(1, Math.floor(Number(reward.amount) || 1))}x ${reward.item}${reward.quality ? ` (${reward.quality})` : ''}`;
}

export function describePayoutDelayReason(reason) {
  switch (reason) {
    case 'payout-in-progress':
      return 'another payout update is already in progress';
    case 'payout-finalization-pending':
      return 'the reward was prepared and will be finalized on the next retry';
    case 'payout-failed':
      return 'reward delivery failed and will be retried automatically';
    case 'rejected-after-retries':
      return 'reward delivery failed repeatedly and now needs admin attention';
    default:
      return 'the reward could not be paid immediately and will be retried automatically';
  }
}

export function describeReferralStatusForPlayer(link) {
  switch (link?.status) {
    case 'pending':
      return 'pending qualification';
    case 'paid':
      return 'reward paid';
    case 'rejected':
      return 'needs admin help';
    case 'paying':
      return 'reward processing';
    default:
      return 'not linked';
  }
}

export function describeReferralProblemForPlayer(reason) {
  if (!reason) return 'Reward delivery ran into a problem. Please ask an admin to review the referral setup.';
  if (/item .*not found/i.test(reason) || /missing item/i.test(reason)) {
    return 'Reward delivery failed because the configured referral item is unavailable. Please ask an admin to review the reward setup.';
  }
  if (/no items are configured/i.test(reason)) {
    return 'Reward delivery failed because referral items are not configured. Please ask an admin to review the reward setup.';
  }
  return 'Reward delivery failed repeatedly. Please ask an admin to review this referral.';
}

async function notifyReferralPayout(gameServerId, referrerId, refereeId, reward) {
  try {
    const [referrerName, refereeName] = await Promise.all([
      getPlayerName(referrerId),
      getPlayerName(refereeId),
    ]);
    const summary = `${referrerName} earned ${describeReward(reward)} thanks to ${refereeName}'s completed referral.`;
    console.log(
      `referral-program: payout notification referrer=${referrerName} (${referrerId}), referee=${refereeName} (${refereeId}), reward=${describeReward(reward)}`,
    );

    try {
      await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
        command: `say [Referral] ${summary}`,
      });
    } catch (broadcastErr) {
      console.warn(`referral-program: failed to broadcast payout notification in-game: ${broadcastErr}`);
    }
  } catch (err) {
    console.error(`referral-program: failed to record payout notification for referrer=${referrerId}, referee=${refereeId}: ${err}`);
  }
}

export async function applyPaidReferral({
  gameServerId,
  moduleId,
  refereeId,
  referrerId,
  link,
  config,
  reason,
  lockScopes,
}) {
  const ownerToken = `${reason}:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;
  const lock = await tryAcquirePayoutLock(gameServerId, moduleId, refereeId, ownerToken);
  if (!lock.acquired) {
    return { paid: false, reason: 'payout-in-progress' };
  }

  try {
    const mutationScopes = Array.isArray(lockScopes)
      ? lockScopes
      : [`referee-link:${refereeId}`, `referrer-quota:${referrerId}`];

    const runPayout = async () => {
        const currentLink = await getReferralLink(gameServerId, moduleId, refereeId) ?? link;
        if (!currentLink) {
          return { paid: false, reason: 'missing-link' };
        }

        if (currentLink.status === 'paid') {
          return { paid: false, reason: 'already-paid' };
        }

        if (currentLink.status === 'rejected') {
          return { paid: false, reason: 'rejected' };
        }

        const effectiveReferrerId = currentLink.referrerId ?? referrerId;
        const [referrerStatsRaw, referrerPog] = await Promise.all([
          getReferralStats(gameServerId, moduleId, effectiveReferrerId),
          getPog(gameServerId, effectiveReferrerId),
        ]);

        const referrerStats = resetDailyCounterIfNeeded(referrerStatsRaw);

        let reward;
        let multiplierInfo;
        let checkpointLink = currentLink;
        const isResume = currentLink.status === 'paying';

        if (isResume) {
          reward = deserializePreparedReward(currentLink);
          if (!reward) {
            throw new Error(`Referral payout for referee=${refereeId} is marked as paying but has no prepared reward.`);
          }
          multiplierInfo = {
            tier: Math.max(0, Math.min(Number(currentLink.vipTier ?? 0) || 0, 5)),
            multiplier: Number(currentLink.vipMultiplier ?? (1 + ((Number(currentLink.vipTier ?? 0) || 0) * 0.05))) || 1,
          };

          if (currentLink.rewardGranted) {
            console.log(`referral-program: resuming payout finalization for referee=${refereeId}, referrer=${effectiveReferrerId}`);
          } else {
            console.log(`referral-program: resuming payout reward delivery for referee=${refereeId}, referrer=${effectiveReferrerId}`);
            await executePreparedReward(gameServerId, effectiveReferrerId, reward);
            checkpointLink = {
              ...currentLink,
              rewardGranted: true,
              rewardGrantedAt: new Date().toISOString(),
            };
            await setReferralLink(gameServerId, moduleId, refereeId, checkpointLink);
          }
        } else {
          multiplierInfo = getVipMultiplier(referrerPog);
          reward = await planReferrerReward(gameServerId, effectiveReferrerId, config, multiplierInfo);
          checkpointLink = {
            ...currentLink,
            status: 'paying',
            payoutPreparedAt: new Date().toISOString(),
            rewardGranted: false,
            rewardGrantedAt: undefined,
            ...serializePreparedRewardFields(reward, multiplierInfo, reason, currentLink.retries ?? 0),
          };
          await setReferralLink(gameServerId, moduleId, refereeId, checkpointLink);
          try {
            await executePreparedReward(gameServerId, effectiveReferrerId, reward);
            checkpointLink = {
              ...checkpointLink,
              rewardGranted: true,
              rewardGrantedAt: new Date().toISOString(),
            };
            await setReferralLink(gameServerId, moduleId, refereeId, checkpointLink);
          } catch (err) {
            await setReferralLink(
              gameServerId,
              moduleId,
              refereeId,
              clearPreparedReward({ ...checkpointLink, status: 'pending', retries: currentLink.retries ?? 0 }),
            );
            throw err;
          }
        }

        const updatedStats = {
          ...referrerStats,
          referralsPaid: referrerStats.referralsPaid + 1,
          currencyEarned: referrerStats.currencyEarned + (reward.rewardType === 'currency' ? (reward.amount ?? 0) : 0),
          itemsEarned: referrerStats.itemsEarned + (reward.rewardType === 'item' ? (reward.amount ?? 0) : 0),
        };
        await setReferralStats(gameServerId, moduleId, effectiveReferrerId, updatedStats);

        const updatedLink = {
          ...checkpointLink,
          referrerId: effectiveReferrerId,
          status: 'paid',
          paidAt: new Date().toISOString(),
          retries: currentLink.retries ?? 0,
          rewardGranted: true,
        };

        await setReferralLink(gameServerId, moduleId, refereeId, updatedLink);
        await removePendingReferee(gameServerId, moduleId, refereeId);
        await notifyReferralPayout(gameServerId, effectiveReferrerId, refereeId, reward);

        console.log(
          `referral-program: paid referrer=${effectiveReferrerId} for referee=${refereeId}, rewardType=${reward.rewardType}, amount=${reward.amount ?? 0}, vipTier=${multiplierInfo.tier}, reason=${reason}`,
        );

        return { paid: true, reward, multiplierInfo, link: updatedLink };
      };

    if (!mutationScopes.length) {
      return await runPayout();
    }

    return await withReferralLocks(
      gameServerId,
      moduleId,
      mutationScopes,
      runPayout,
      {
        ownerTokenPrefix: `referral-payout:${refereeId}`,
        busyMessage: 'Another referral update is already in progress. Please try again in a moment.',
      },
    );
  } finally {
    await releasePayoutLock(gameServerId, moduleId, refereeId, ownerToken);
  }
}

export async function rejectPendingReferral(gameServerId, moduleId, refereeId, link, reason) {
  const updated = {
    ...link,
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    rejectionReason: reason,
    retries: link.retries ?? 0,
  };
  await setReferralLink(gameServerId, moduleId, refereeId, updated);
  await removePendingReferee(gameServerId, moduleId, refereeId);
  await adjustReferrerStatsForLink(gameServerId, moduleId, link.referrerId, link, -1);
}

export async function incrementLinkRetry(gameServerId, moduleId, refereeId, link, reason, options = {}) {
  const updated = {
    ...link,
    ...options,
    retries: (link.retries ?? 0) + 1,
    lastError: reason,
    lastTriedAt: new Date().toISOString(),
  };
  await setReferralLink(gameServerId, moduleId, refereeId, updated);
  return updated;
}

export async function maybePayReferral(gameServerId, moduleId, refereeId, mod, reason) {
  const config = getNormalizedConfig(mod);
  const link = await getReferralLink(gameServerId, moduleId, refereeId);
  if (!link) {
    return { paid: false, reason: 'no-link' };
  }

  if (link.status === 'paid') {
    await removePendingReferee(gameServerId, moduleId, refereeId);
    return { paid: false, reason: 'already-paid' };
  }

  if (link.status === 'rejected') {
    await removePendingReferee(gameServerId, moduleId, refereeId);
    return { paid: false, reason: 'rejected' };
  }

  if (link.status === 'linking') {
    return { paid: false, reason: 'link-creation-in-progress' };
  }

  if (link.status === 'pending') {
    const pog = await getPog(gameServerId, refereeId);
    if (!pog) {
      console.warn(`referral-program: could not find POG for referee=${refereeId}; leaving pending`);
      return { paid: false, reason: 'missing-pog' };
    }

    const currentPlaytimeMinutes = getPlaytimeMinutes(pog);
    const playtimeAtLink = Number(link.playtimeAtLink ?? 0) || 0;
    const earnedSinceLink = currentPlaytimeMinutes - playtimeAtLink;

    if (earnedSinceLink < config.playtimeThresholdMinutes) {
      return { paid: false, reason: 'threshold-not-met', currentPlaytimeMinutes, earnedSinceLink };
    }
  }

  try {
    return await applyPaidReferral({
      gameServerId,
      moduleId,
      refereeId,
      referrerId: link.referrerId,
      link,
      config,
      reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const latestLink = await getReferralLink(gameServerId, moduleId, refereeId);

    if (latestLink?.status === 'paying') {
      console.error(`referral-program: payout finalization paused for referee=${refereeId}. Error: ${message}`);
      return { paid: false, reason: 'payout-finalization-pending', error: message };
    }

    const retryBase = latestLink ?? link;
    const updatedLink = await incrementLinkRetry(
      gameServerId,
      moduleId,
      refereeId,
      clearPreparedReward({ ...retryBase, status: 'pending' }),
      message,
    );
    console.error(`referral-program: payout failed for referee=${refereeId}, retry=${updatedLink.retries}. Error: ${message}`);
    if (updatedLink.retries >= 3) {
      await rejectPendingReferral(gameServerId, moduleId, refereeId, updatedLink, message);
      return { paid: false, reason: 'rejected-after-retries', error: message };
    }
    return { paid: false, reason: 'payout-failed', error: message };
  }
}
