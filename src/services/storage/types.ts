import type { ActiveTimerState, AppSettings, DayFlowState } from '../../types/dayflow';
import type { EkuChatMessage, EkuResourceItem } from '../../types/eku';
import type { LibraryResource } from '../../types/library';
import type { StoredReminderState } from '../../types/reminder';

export type StorageBackendKind = 'opfs' | 'indexeddb' | 'memory';

export interface WorkspaceMetaRecord {
  id: 'singleton';
  version: number;
  settings: AppSettings;
  activeTimer: ActiveTimerState;
  importedFingerprints: string[];
  updatedAt: string;
}

export interface HabitLogRecord {
  date: string;
  habitIds: string[];
}

export interface ReminderStoreRecord {
  scopeKey: string;
  state: StoredReminderState;
  updatedAt: string;
}

export interface EkuConversationRecord {
  id: string;
  messages: EkuChatMessage[];
  updatedAt: string;
}

export interface SavedResearchRecord {
  id: string;
  topic: string;
  queryText: string;
  savedAt: string;
  resource: EkuResourceItem;
}

export type BlobAssetKind = 'pdf' | 'cover' | 'temp';

export interface BlobMetaRecord {
  key: string;
  kind: BlobAssetKind;
  sizeBytes: number;
  mimeType: string;
  fileName: string | null;
  fileHash: string | null;
  chunkCount: number;
  backend: StorageBackendKind;
  createdAt: string;
  updatedAt: string;
}

export interface FileChunkRecord {
  id: string; // `${key}::${chunkIndex}`
  key: string;
  chunkIndex: number;
  blob: Blob;
}

export interface StorageQuotaReport {
  supported: boolean;
  isPersisted: boolean;
  totalUsedBytes: number;
  pdfBytes: number;
  coverAndCacheBytes: number;
  appDataBytes: number;
  estimatedQuotaBytes: number | null;
  estimatedAvailableBytes: number | null;
  savedResourcesCount: number;
  pdfCount: number;
  linkCount: number;
  storageBackend: StorageBackendKind;
}

export interface BackupBundleV2 {
  backupVersion: 2;
  exportedAt: string;
  app: 'Ekagra';
  data: DayFlowState;
  libraryResources?: LibraryResource[];
  aiConversations?: EkuConversationRecord[];
  researchResults?: SavedResearchRecord[];
  reminders?: ReminderStoreRecord[];
}

export type StorageSyncTopic =
  | 'workspace'
  | 'library'
  | 'eku_chat'
  | 'research'
  | 'reminders'
  | 'preferences'
  | 'storage_reset';

export interface StorageSyncEvent {
  topic: StorageSyncTopic;
  sourceTabId: string;
  timestamp: number;
  detail?: string;
}

/**
 * Future-proof modular interfaces allowing Web (IndexedDB + OPFS),
 * PWA, Capacitor, Tauri, or optional cloud providers to share the same contracts.
 */
export interface IAppDatabase {
  loadWorkspaceState(): Promise<{ state: DayFlowState; migratedFromLegacy: boolean }>;
  saveWorkspaceState(state: DayFlowState): Promise<void>;
  listLibraryResources(): Promise<LibraryResource[]>;
  saveLibraryResource(resource: LibraryResource): Promise<void>;
  deleteLibraryResource(id: string): Promise<void>;
}

export interface ILargeFileStore {
  savePdfStream(
    key: string,
    file: File | Blob,
    options?: {
      fileName?: string;
      onProgress?: (writtenBytes: number, totalBytes: number) => void;
      signal?: AbortSignal;
    }
  ): Promise<BlobMetaRecord>;
  readPdfRange(key: string, begin: number, end: number): Promise<Uint8Array>;
  deleteAsset(key: string): Promise<void>;
}

export interface IPreferencesStore {
  getPreference<K extends keyof LocalUiPreferences>(key: K): LocalUiPreferences[K] | null;
  setPreference<K extends keyof LocalUiPreferences>(key: K, value: LocalUiPreferences[K]): void;
}

export interface LocalUiPreferences {
  theme: AppSettings['theme'];
  timeFormat: AppSettings['timeFormat'];
  weekStart: AppSettings['weekStart'];
  ekuMuted: boolean;
  preferredResourceLanguage: string | null;
  activePage: string;
}
