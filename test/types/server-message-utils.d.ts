declare module '../../modules/server-messages/src/functions/server-message-utils.js' {
  export const DEFAULT_INTERVAL: string;
  export const DEFAULT_TIME_ZONE: string;
  export const MAX_MESSAGES: number;
  export const MAX_WEIGHT: number;
  export const SUPPORTED_PLACEHOLDERS: string[];

  export function normalizeMessages(messages: unknown): Array<{ text: string; weight: number }>;
  export function normalizeOrder(order: unknown): 'sequential' | 'random';
  export function normalizeInterval(interval: unknown): string;
  export function normalizeWeight(weight: unknown): number;
  export function normalizeTimeZone(timeZone: unknown): string;
  export function isValidTimeZone(timeZone: string): boolean;
  export function computeFingerprint(order: string, messages: Array<{ text: string; weight: number }>): string;
  export function hashString(input: string): string;
  export function getInitialState(order: string, messages: Array<{ text: string; weight: number }>): unknown;
  export function getNextSelection(order: string, messages: Array<{ text: string; weight: number }>, state: unknown): unknown;
  export function findUnknownPlaceholders(text: string): string[];
  export function renderPlaceholders(text: string, context: { playerCount: number; serverName: string }): string;
  export function shuffleBag(messages: Array<{ text: string; weight: number }>): number[];
  export function getIntervalStatus(interval: string, now?: Date, timeZone?: string): {
    valid: boolean;
    matches: boolean;
    normalized: string;
  };
  export function createExecutionLockHeartbeat(
    refreshFn: () => Promise<boolean>,
    options?: {
      intervalMs?: number;
      setTimeoutFn?: (fn: () => void, delay: number) => unknown;
      clearTimeoutFn?: (id: unknown) => void;
    },
  ): {
    heartbeat: () => Promise<boolean>;
    stopHeartbeat: () => Promise<void>;
  };
}

declare module '../src/functions/server-message-utils.js' {
  export * from '../../modules/server-messages/src/functions/server-message-utils.js';
}
