export interface OnlinePlayerLike {
  name?: string | null | undefined;
  playerName?: string | null | undefined;
}

export interface PlayerWithIdLike extends OnlinePlayerLike {
  playerId?: string | null | undefined;
  gameId?: string | null | undefined;
}

export interface PaginatedResult<T> {
  data?: T[] | null | undefined;
  total?: number | undefined;
}

export function trimOrEmpty(value: unknown): string;
export function formatOnlinePlayersLine(players: OnlinePlayerLike[]): string;
export function collapsePlayersById<T extends PlayerWithIdLike>(players: T[]): T[];
export function collectPaginatedResults<T>(
  fetchPage: (args: { page: number; limit: number }) => Promise<PaginatedResult<T>>,
  options?: { limit?: number; maxIterations?: number },
): Promise<T[]>;
