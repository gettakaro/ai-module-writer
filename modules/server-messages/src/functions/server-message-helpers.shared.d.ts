export interface ServerMessage {
  text: string;
  weight: number;
}

export interface ServerMessageState {
  fingerprint: string;
  sequentialIndex: number;
  bag: number[];
  cursor: number;
}

export declare const SERVER_MESSAGES_STATE_KEY: 'server_messages_state';
export declare const SERVER_MESSAGES_LOCK_KEY: 'server_messages_lock';
export declare const SERVER_MESSAGES_DELIVERY_RECEIPT_KEY: 'server_messages_delivery_receipt';
export declare const MAX_MESSAGE_WEIGHT: 100;
export declare const MAX_MESSAGE_COUNT: 100;

export declare function normalizeMessages(rawMessages: unknown): ServerMessage[];
export declare function normalizeWeight(weight: unknown): number;
export declare function normalizeOrder(order: unknown): 'sequential' | 'random';
export declare function buildConfigFingerprint(order: unknown, messages: unknown): string;
export declare function createInitialState(fingerprint?: string): ServerMessageState;
export declare function coerceState(rawState: unknown): ServerMessageState;
export declare function buildWeightedBag(messages: Array<{ weight?: unknown }>): number[];
export declare function shuffleBag(entries: number[]): number[];
export declare function getServerNameFallback(): string;
export declare function renderMessage(template: string, context: Record<string, unknown>): string;
