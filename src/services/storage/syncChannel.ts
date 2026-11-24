import type { StorageSyncEvent, StorageSyncTopic } from './types';

const CHANNEL_NAME = 'ekagra_sync_v1';
const STORAGE_PING_KEY = 'ekagra_sync_ping_v1';

const TAB_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

type SyncListener = (event: StorageSyncEvent) => void;

const listeners = new Set<SyncListener>();
let broadcastChannel: BroadcastChannel | null = null;
let initialized = false;

function dispatchToListeners(event: StorageSyncEvent, includeSameTab: boolean): void {
  if (!includeSameTab && event.sourceTabId === TAB_ID) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Keep other subscribers healthy
    }
  }
}

function ensureInitialized(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
      broadcastChannel.onmessage = (msg: MessageEvent<unknown>) => {
        const data = msg.data as Partial<StorageSyncEvent> | null;
        if (!data || typeof data.topic !== 'string' || typeof data.sourceTabId !== 'string') {
          return;
        }
        dispatchToListeners(
          {
            topic: data.topic as StorageSyncTopic,
            sourceTabId: data.sourceTabId,
            timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
            detail: typeof data.detail === 'string' ? data.detail : undefined,
          },
          false
        );
      };
    } catch {
      broadcastChannel = null;
    }
  }

  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== STORAGE_PING_KEY || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue) as Partial<StorageSyncEvent>;
      if (!parsed || typeof parsed.topic !== 'string' || typeof parsed.sourceTabId !== 'string') {
        return;
      }
      dispatchToListeners(
        {
          topic: parsed.topic as StorageSyncTopic,
          sourceTabId: parsed.sourceTabId,
          timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now(),
          detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
        },
        false
      );
    } catch {
      // Ignore malformed storage pings
    }
  });
}

export function getSyncTabId(): string {
  return TAB_ID;
}

export function publishSyncEvent(
  topic: StorageSyncTopic,
  options?: { detail?: string; notifyCurrentTab?: boolean }
): void {
  ensureInitialized();
  const payload: StorageSyncEvent = {
    topic,
    sourceTabId: TAB_ID,
    timestamp: Date.now(),
    detail: options?.detail,
  };

  if (options?.notifyCurrentTab) {
    dispatchToListeners(payload, true);
  }

  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(payload);
    } catch {
      // Fall back to storage ping below
    }
  }

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_PING_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage ping errors
    }
  }
}

export function subscribeSyncChannel(
  topics: StorageSyncTopic[] | '*',
  listener: SyncListener
): () => void {
  ensureInitialized();
  const wrapped: SyncListener = (event) => {
    if (topics === '*' || topics.includes(event.topic)) {
      listener(event);
    }
  };
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}
