import type { EkuChatMessage, EkuResourceItem } from '../../types/eku';
import { idbDelete, idbGet, idbGetAll, idbPut, idbReplaceStore, STORE_NAMES } from './indexedDb';
import { publishSyncEvent } from './syncChannel';
import type { EkuConversationRecord, SavedResearchRecord } from './types';

const DEFAULT_THREAD_ID = 'eku_default_thread';
const MAX_STORED_MESSAGES = 80;
const MAX_STORED_RESEARCH = 100;

export async function loadEkuMessages(threadId = DEFAULT_THREAD_ID): Promise<EkuChatMessage[]> {
  try {
    const rec = await idbGet<EkuConversationRecord>(STORE_NAMES.AI_CONVERSATIONS, threadId);
    if (!rec || !Array.isArray(rec.messages)) return [];
    return rec.messages.filter(
      (m) =>
        m &&
        typeof m.id === 'string' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.text === 'string'
    );
  } catch {
    return [];
  }
}

export async function saveEkuMessages(
  messages: EkuChatMessage[],
  threadId = DEFAULT_THREAD_ID
): Promise<void> {
  const trimmed = messages.slice(-MAX_STORED_MESSAGES);
  const record: EkuConversationRecord = {
    id: threadId,
    messages: trimmed,
    updatedAt: new Date().toISOString(),
  };
  await idbPut(STORE_NAMES.AI_CONVERSATIONS, record);
  publishSyncEvent('eku_chat', { detail: threadId });
}

export async function clearEkuMessages(threadId = DEFAULT_THREAD_ID): Promise<void> {
  await idbDelete(STORE_NAMES.AI_CONVERSATIONS, threadId);
  publishSyncEvent('eku_chat', { detail: threadId });
}

export async function loadSavedResearchResults(): Promise<SavedResearchRecord[]> {
  try {
    const all = await idbGetAll<SavedResearchRecord>(STORE_NAMES.RESEARCH_RESULTS);
    return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}

export async function saveEkuResearchResults(
  queryText: string,
  resources: EkuResourceItem[]
): Promise<void> {
  if (!resources || resources.length === 0) return;
  const existing = await loadSavedResearchResults();
  const now = new Date().toISOString();
  const topic = queryText.trim().slice(0, 100) || 'Study Resources';

  const byUrl = new Map<string, SavedResearchRecord>();
  for (const rec of existing) {
    byUrl.set(rec.resource.url, rec);
  }

  for (const res of resources) {
    if (!res?.url) continue;
    const id = byUrl.get(res.url)?.id ?? `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    byUrl.set(res.url, {
      id,
      topic,
      queryText: queryText.trim().slice(0, 240),
      savedAt: now,
      resource: res,
    });
  }

  const merged = Array.from(byUrl.values())
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    .slice(0, MAX_STORED_RESEARCH);

  await idbReplaceStore(STORE_NAMES.RESEARCH_RESULTS, merged);
  publishSyncEvent('research');
}

export async function deleteSavedResearchResult(id: string): Promise<void> {
  await idbDelete(STORE_NAMES.RESEARCH_RESULTS, id);
  publishSyncEvent('research');
}

export async function clearSavedResearchResults(): Promise<void> {
  await idbReplaceStore<SavedResearchRecord>(STORE_NAMES.RESEARCH_RESULTS, []);
  publishSyncEvent('research');
}
