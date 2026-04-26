export function isBlank(value: unknown): boolean;
export function trimOrEmpty(value: unknown): string;
export function normalizeReason(value: unknown, fallback: string): string;
export function compactRules(rules: unknown): string[];
export function formatOnlinePlayersLine(players: Array<{ name?: unknown; playerName?: unknown }>): string;
export function getCommandTargetPlayer(target: unknown): {
  playerId: string;
  name: string;
  gameId: string;
  gameServerId: string;
  online: unknown;
} | null;
export function renderTemplate(template: unknown, placeholders: Record<string, unknown>): string;
export function parseBanDurationToken(token: unknown): {
  isPermanent: boolean;
  expiresAt?: string;
  humanDuration: string;
  normalizedToken: string;
} | null;
