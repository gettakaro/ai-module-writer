export interface OnlinePlayerLike {
  name?: string | null | undefined;
  playerName?: string | null | undefined;
}

export function formatOnlinePlayersLine(players: OnlinePlayerLike[]): string;
