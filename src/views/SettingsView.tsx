import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BiIcon } from '../components/ui/BiIcon';
import { useDayFlow } from '../context/DayFlowContext';
import { useAuth } from '../hooks/useAuth';
import {
  deleteLibraryResourceApi,
  listLibraryResourcesApi,
  runLibraryOrphanCleanup,
} from '../services/libraryService';
import {
  blobStore,
  requestPersistentStorageSafely,
} from '../services/storage/blobStore';
import { subscribeSyncChannel } from '../services/storage/syncChannel';
import type { StorageQuotaReport } from '../services/storage/types';
import { TimeFormat, WeekStartDay } from '../types/dayflow';
import type { LibraryResource } from '../types/library';
import {
  getNotificationPermissionStatus,
  requestNotificationPermissionFromUser,
} from '../utils/notifications';
import { THEME_OPTIONS } from '../utils/theme';

function formatStorageBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return 'Managed by device';
  }
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export const SettingsView: React.FC = () => {
  const {
    status: authStatus,
    user,
    isSupabaseConfigured,
    isSigningIn,
    signInWithGoogle,
    openAuthFromGuest,
  } = useAuth();
  const {
    state,
    updateSettings,
    exportFullBackup,
    importFullBackup,
    clearAllData,
    pushToast,
  } = useDayFlow();

  const { settings } = state;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [notifStatus, setNotifStatus] = useState(getNotificationPermissionStatus);

  const [storageReport, setStorageReport] = useState<StorageQuotaReport | null>(null);
  const [savedResources, setSavedResources] = useState<LibraryResource[]>([]);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [cleaningCache, setCleaningCache] = useState(false);
  const [exportingBackup, setExportingBackup] = useState(false);
  const [importingBackup, setImportingBackup] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);

  const refreshStorageStats = useCallback(async () => {
    try {
      const [diag, resources] = await Promise.all([
        blobStore.getStorageDiagnostics(),
        listLibraryResourcesApi(),
      ]);
      setStorageReport(diag);
      setSavedResources(resources);
    } catch {
      // Keep UI functional even if diagnostics fail temporarily
    } finally {
      setLoadingStorage(false);
    }
  }, []);

  useEffect(() => {
    void refreshStorageStats();
    return subscribeSyncChannel(
      ['workspace', 'library', 'eku_chat', 'research', 'storage_reset'],
      () => {
        void refreshStorageStats();
      }
    );
  }, [refreshStorageStats, state.activities.length, state.tasks.length, state.notes.length]);

  const handleEnableNotifications = async () => {
    const result = await requestNotificationPermissionFromUser();
    setNotifStatus(result);
    if (result === 'granted') {
      updateSettings({ notificationsEnabled: true });
      pushToast({
        type: 'success',
        title: 'Reminders enabled',
        description: 'You will get browser alerts while Ekagra is open.',
      });
    } else if (result === 'denied') {
      updateSettings({ notificationsEnabled: false });
      pushToast({
        type: 'warning',
        title: 'Permission blocked',
        description: 'Allow notifications in your browser site settings.',
      });
    } else if (result === 'unsupported') {
      pushToast({
        type: 'warning',
        title: 'Unsupported',
        description: 'This browser does not support desktop notifications.',
      });
    }
  };

  const handleRequestPersistence = async () => {
    const granted = await requestPersistentStorageSafely();
    await refreshStorageStats();
    pushToast({
      type: granted ? 'success' : 'info',
      title: granted ? 'Offline protection active' : 'Standard browser storage active',
      description: granted
        ? 'Your browser marked this device storage as persistent.'
        : 'Your browser decides storage retention automatically on this device.',
    });
  };

  const handleCleanupCache = async () => {
    setCleaningCache(true);
    try {
      const removed = await runLibraryOrphanCleanup();
      await refreshStorageStats();
      pushToast({
        type: 'success',
        title: 'Temporary cache cleaned',
        description:
          removed > 0
            ? `Cleared ${removed} unused temporary ${removed === 1 ? 'file' : 'files'}. Saved PDFs were untouched.`
            : 'No unused temporary files were found.',
      });
    } finally {
      setCleaningCache(false);
    }
  };

  const handleDeleteSavedResource = async (resourceId: string) => {
    setDeletingResourceId(resourceId);
    try {
      await deleteLibraryResourceApi(
        {
          accessToken: null,
          isGuest: true,
        },
        resourceId
      );
      setConfirmDeleteId(null);
      await refreshStorageStats();
      pushToast({
        type: 'success',
        title: 'Resource removed',
        description: 'Deleted from your device Library and freed its storage space.',
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not delete resource',
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setDeletingResourceId(null);
    }
  };

  const handleExport = async () => {
    setExportingBackup(true);
    try {
      const json = await exportFullBackup();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ekagra-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      pushToast({
        type: 'success',
        title: 'Backup downloaded',
        description: 'Saved your schedules, notes, library metadata, and Eku history to this device.',
      });
    } finally {
      setExportingBackup(false);
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingBackup(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await importFullBackup(String(reader.result ?? ''));
        await refreshStorageStats();
        pushToast({
          type: 'success',
          title: 'Backup restored',
          description: 'Your workspace data has been imported safely.',
        });
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Restore failed',
          description:
            err instanceof Error
              ? err.message
              : 'Invalid Ekagra backup file. Your existing data was left untouched.',
        });
      } finally {
        setImportingBackup(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.onerror = () => {
      setImportingBackup(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      pushToast({
        type: 'error',
        title: 'Restore failed',
        description: 'Could not read the selected backup file.',
      });
    };
    reader.readAsText(file);
  };

  const handleConfirmClear = async () => {
    await clearAllData();
    await refreshStorageStats();
    setConfirmClearOpen(false);
    pushToast({
      type: 'info',
      title: 'Workspace reset',
      description: 'Schedules, tasks, habits, and assistant history have been cleared.',
    });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-[var(--df-text)]">
          Settings
        </h1>
        <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
          Make Ekagra feel like yours.
        </p>
      </div>

      {/* Theme Selector */}
      <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
        <div className="flex items-center gap-2 border-b border-[var(--df-border)] pb-3">
          <BiIcon name="palette" className="text-sm text-[var(--df-text)]" />
          <h2 className="text-sm font-semibold text-[var(--df-text)]">
            Theme
          </h2>
        </div>

        <div
          role="radiogroup"
          aria-label="Theme preference"
          className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {THEME_OPTIONS.map((opt) => {
            const selected = settings.theme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => updateSettings({ theme: opt.id })}
                className={`flex items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                  selected
                    ? 'border-[var(--df-accent)] bg-[var(--df-accent-soft)]'
                    : 'border-[var(--df-border)] bg-[var(--df-bg)] hover:border-[var(--df-border-strong)]'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border"
                  style={{
                    backgroundColor: opt.previewBg,
                    borderColor: opt.previewBorder,
                  }}
                >
                  <span
                    className="h-4 w-4 rounded-md"
                    style={{ backgroundColor: opt.previewAccent }}
                  />
                  {selected && (
                    <span
                      className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full"
                      style={{
                        backgroundColor: opt.previewAccent,
                        color: 'var(--df-accent-fg)',
                      }}
                    >
                      <BiIcon name="check-lg" className="text-[11px] font-bold" />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-[var(--df-text)]">
                    {opt.label}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--df-text-muted)]">
                    {opt.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Display & Preferences */}
      <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
        <h2 className="border-b border-[var(--df-border)] pb-3 text-sm font-semibold text-[var(--df-text)]">
          Basics
        </h2>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pref-name" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
                Your name
              </label>
              <input
                id="pref-name"
                type="text"
                value={settings.userName}
                onChange={(e) => updateSettings({ userName: e.target.value })}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="pref-timefmt" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
                Clock format
              </label>
              <select
                id="pref-timefmt"
                value={settings.timeFormat}
                onChange={(e) => updateSettings({ timeFormat: e.target.value as TimeFormat })}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
              >
                <option value="12h">12-hour (9:00 AM)</option>
                <option value="24h">24-hour (09:00)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pref-weekstart" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
                Week starts
              </label>
              <select
                id="pref-weekstart"
                value={settings.weekStart}
                onChange={(e) => updateSettings({ weekStart: e.target.value as WeekStartDay })}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
              >
                <option value="monday">Monday</option>
                <option value="sunday">Sunday</option>
              </select>
            </div>

            <div>
              <label htmlFor="pref-cap" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
                Daily capacity (h)
              </label>
              <input
                id="pref-cap"
                type="number"
                min={2}
                max={16}
                value={settings.dailyCapacityHours}
                onChange={(e) =>
                  updateSettings({
                    dailyCapacityHours: Math.max(2, Math.min(16, Number(e.target.value) || 8)),
                  })
                }
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 font-mono text-sm tabular-nums text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 py-3">
            <div className="space-y-0.5">
              <label
                htmlFor="pref-auto-sync-pdf"
                className="block cursor-pointer text-sm font-medium text-[var(--df-text)]"
              >
                Auto-sync verified schedule PDFs to Calendar
              </label>
              <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
                When enabled, unambiguous study sessions with explicit calendar dates and times automatically sync to your Calendar upon upload (duplicates are skipped and overlapping times stay highlighted for review).
              </p>
            </div>
            <input
              id="pref-auto-sync-pdf"
              type="checkbox"
              checked={settings.autoSyncPdfSchedule}
              onChange={(e) =>
                updateSettings({ autoSyncPdfSchedule: e.target.checked })
              }
              className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
            />
          </div>
        </div>
      </section>

      {/* Focus Timer Defaults */}
      <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
        <h2 className="border-b border-[var(--df-border)] pb-3 text-sm font-semibold text-[var(--df-text)]">
          Focus timer
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="pref-focus-min" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
              Focus (min)
            </label>
            <input
              id="pref-focus-min"
              type="number"
              min={5}
              max={180}
              value={settings.defaultFocusMinutes}
              onChange={(e) =>
                updateSettings({
                  defaultFocusMinutes: Math.max(5, Math.min(180, Number(e.target.value) || 25)),
                })
              }
              className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 font-mono text-sm tabular-nums text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="pref-sbreak-min" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
              Short break (min)
            </label>
            <input
              id="pref-sbreak-min"
              type="number"
              min={1}
              max={60}
              value={settings.shortBreakMinutes}
              onChange={(e) =>
                updateSettings({
                  shortBreakMinutes: Math.max(1, Math.min(60, Number(e.target.value) || 5)),
                })
              }
              className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 font-mono text-sm tabular-nums text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="pref-lbreak-min" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
              Long break (min)
            </label>
            <input
              id="pref-lbreak-min"
              type="number"
              min={5}
              max={90}
              value={settings.longBreakMinutes}
              onChange={(e) =>
                updateSettings({
                  longBreakMinutes: Math.max(5, Math.min(90, Number(e.target.value) || 15)),
                })
              }
              className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 font-mono text-sm tabular-nums text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
            />
          </div>
        </div>
      </section>

      {/* Reminders */}
      <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
        <div className="flex items-center gap-2 border-b border-[var(--df-border)] pb-3">
          <BiIcon name="bell" className="text-sm text-[var(--df-text)]" />
          <h2 className="text-sm font-semibold text-[var(--df-text)]">
            Reminders
          </h2>
        </div>

        <div className="mt-4 space-y-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-medium text-[var(--df-text)]">
                Browser notifications
              </p>
              <p className="text-xs text-[var(--df-text-muted)]">
                Status: <span className="font-mono font-medium">{notifStatus}</span>
              </p>
            </div>

            <div>
              {notifStatus !== 'granted' ? (
                <button
                  type="button"
                  onClick={handleEnableNotifications}
                  className="rounded-xl bg-[var(--df-accent)] px-4 py-2 text-xs font-semibold text-[var(--df-accent-fg)]"
                >
                  Allow reminders
                </button>
              ) : (
                <label className="flex items-center gap-2 text-xs font-medium text-[var(--df-text)]">
                  <input
                    type="checkbox"
                    checked={settings.notificationsEnabled}
                    onChange={(e) => updateSettings({ notificationsEnabled: e.target.checked })}
                    className="rounded border-[var(--df-border-strong)]"
                  />
                  Active
                </label>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pref-lead" className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
                Notify me
              </label>
              <select
                id="pref-lead"
                value={settings.reminderLeadMinutes}
                onChange={(e) =>
                  updateSettings({
                    reminderLeadMinutes: Number(e.target.value) as 0 | 5 | 10 | 15,
                  })
                }
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)]"
              >
                <option value={0}>At start time</option>
                <option value={5}>5 min before</option>
                <option value={10}>10 min before</option>
                <option value={15}>15 min before</option>
              </select>
            </div>

            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-[var(--df-text)]">
                <input
                  type="checkbox"
                  checked={settings.soundAlerts}
                  onChange={(e) => updateSettings({ soundAlerts: e.target.checked })}
                  className="rounded border-[var(--df-border-strong)]"
                />
                Play gentle sound chime
              </label>
            </div>
          </div>

          <p className="rounded-2xl bg-[var(--df-bg)] px-3.5 py-2.5 text-xs text-[var(--df-text-muted)]">
            Full-screen reminders appear inside the open app viewport, and native browser notifications run separately when granted. Neither fires when your browser is closed.
          </p>
        </div>
      </section>

      {/* Storage Management & Backups */}
      <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--df-border)] pb-3">
          <div className="flex items-center gap-2">
            {authStatus === 'authenticated' ? (
              <BiIcon name="cloud-check" className="text-sm text-[var(--df-accent-soft-fg)]" />
            ) : (
              <BiIcon name="hdd" className="text-sm text-[var(--df-text-muted)]" />
            )}
            <h2 className="text-sm font-semibold text-[var(--df-text)]">
              {authStatus === 'authenticated'
                ? 'Account, Storage & Backups'
                : 'Device Storage & Backups'}
            </h2>
          </div>

          {storageReport && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--df-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--df-text-muted)]">
              <BiIcon
                name={storageReport.isPersisted ? 'shield-check' : 'check-circle'}
                className="text-xs text-[var(--df-accent-soft-fg)]"
              />
              {storageReport.isPersisted ? 'Protected offline' : 'Available offline'}
            </span>
          )}
        </div>

        <div className="mt-4 space-y-5">
          {authStatus === 'authenticated' ? (
            <p className="rounded-2xl bg-[var(--df-bg)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--df-text-muted)]">
              Signed in as{' '}
              <span className="font-medium text-[var(--df-text)]">
                {user?.email || 'your Ekagra account'}
              </span>
              . Your Ekagra workspace stays isolated from device-only workspace data.
            </p>
          ) : (
            <div className="flex flex-col justify-between gap-3 rounded-2xl bg-[var(--df-bg)] px-3.5 py-3 sm:flex-row sm:items-center">
              <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
                All schedules, tasks, notes, assistant history, and saved Library PDFs are stored on this device and work offline. Data is not automatically backed up to the cloud — export a backup file anytime.
              </p>
              {isSupabaseConfigured && (
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isSigningIn}
                    onClick={() => void signInWithGoogle()}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-3 text-xs font-semibold text-[var(--df-accent-fg)] hover:brightness-95 disabled:opacity-50"
                  >
                    <BiIcon name="box-arrow-in-right" className="text-xs" />
                    {isSigningIn ? 'Connecting...' : 'Sign in with Google'}
                  </button>
                  <button
                    type="button"
                    disabled={isSigningIn}
                    onClick={openAuthFromGuest}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)] disabled:opacity-50"
                  >
                    <BiIcon name="box-arrow-in-right" className="text-xs" />
                    Sign in with Email
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Storage Usage Metrics */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
                Storage Overview
              </h3>
              {storageReport && !storageReport.isPersisted && (
                <button
                  type="button"
                  onClick={() => void handleRequestPersistence()}
                  className="text-[11px] font-semibold text-[var(--df-accent-soft-fg)] hover:underline"
                >
                  Protect offline storage
                </button>
              )}
            </div>

            {loadingStorage ? (
              <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 py-3 text-xs text-[var(--df-text-muted)]">
                Checking device storage usage...
              </div>
            ) : storageReport ? (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
                  <p className="text-[11px] text-[var(--df-text-muted)]">Total storage used</p>
                  <p className="mt-1 font-mono text-sm font-bold tabular-nums text-[var(--df-text)]">
                    {formatStorageBytes(storageReport.totalUsedBytes)}
                  </p>
                </div>

                <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
                  <p className="text-[11px] text-[var(--df-text-muted)]">Saved resources</p>
                  <p className="mt-1 font-mono text-sm font-bold tabular-nums text-[var(--df-text)]">
                    {storageReport.savedResourcesCount}
                    <span className="ml-1.5 text-[11px] font-normal text-[var(--df-text-muted)]">
                      ({storageReport.pdfCount} PDF · {storageReport.linkCount} link)
                    </span>
                  </p>
                </div>

                <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
                  <p className="text-[11px] text-[var(--df-text-muted)]">Available space</p>
                  <p className="mt-1 font-mono text-sm font-bold tabular-nums text-[var(--df-text)]">
                    {formatStorageBytes(storageReport.estimatedAvailableBytes)}
                  </p>
                </div>

                <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
                  <p className="text-[11px] text-[var(--df-text-muted)]">PDF storage</p>
                  <p className="mt-1 font-mono text-sm font-bold tabular-nums text-[var(--df-text)]">
                    {formatStorageBytes(storageReport.pdfBytes)}
                  </p>
                </div>

                <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
                  <p className="text-[11px] text-[var(--df-text-muted)]">App data usage</p>
                  <p className="mt-1 font-mono text-sm font-bold tabular-nums text-[var(--df-text)]">
                    {formatStorageBytes(storageReport.appDataBytes)}
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
                  <div>
                    <p className="text-[11px] text-[var(--df-text-muted)]">Temp cache</p>
                    <p className="mt-0.5 text-xs font-semibold text-[var(--df-text)]">
                      {formatStorageBytes(storageReport.coverAndCacheBytes)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={cleaningCache}
                    onClick={() => void handleCleanupCache()}
                    className="rounded-xl border border-[var(--df-border-strong)] bg-[var(--df-surface)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--df-text)] hover:border-[var(--df-accent)] disabled:opacity-60"
                  >
                    {cleaningCache ? 'Cleaning...' : 'Clean cache'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Individual Saved Resources List */}
          {savedResources.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
                Saved Library Resources ({savedResources.length})
              </h3>
              <div className="max-h-56 divide-y divide-[var(--df-border)] overflow-y-auto rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)]">
                {savedResources.map((res) => (
                  <div
                    key={res.id}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-[var(--df-text)]">
                        {res.title}
                      </p>
                      <p className="truncate text-[11px] text-[var(--df-text-muted)]">
                        {res.resourceType === 'pdf' ? 'PDF' : 'Study link'} · {res.subject}
                        {res.originalFileSize ? ` · ${formatStorageBytes(res.originalFileSize)}` : ''}
                      </p>
                    </div>

                    {confirmDeleteId === res.id ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={deletingResourceId === res.id}
                          onClick={() => void handleDeleteSavedResource(res.id)}
                          className="rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                        >
                          {deletingResourceId === res.id ? 'Removing...' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-lg border border-[var(--df-border)] px-2 py-1 text-[11px] font-medium text-[var(--df-text-muted)]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(res.id)}
                        aria-label={`Delete ${res.title}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 text-[11px] font-medium text-[var(--df-text-muted)] hover:border-rose-400 hover:text-rose-500"
                      >
                        <BiIcon name="trash3" className="text-xs" />
                        Delete
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Backup, Restore & Reset */}
          <div className="flex flex-wrap items-center gap-2.5 border-t border-[var(--df-border)] pt-4">
            <button
              type="button"
              disabled={exportingBackup}
              onClick={() => void handleExport()}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)] disabled:opacity-60"
            >
              <BiIcon name="download" className="text-xs" />
              {exportingBackup ? 'Preparing backup...' : 'Export Backup JSON'}
            </button>

            <button
              type="button"
              disabled={importingBackup}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)] disabled:opacity-60"
            >
              <BiIcon name="upload" className="text-xs" />
              {importingBackup ? 'Restoring...' : 'Restore Backup JSON'}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImportFile}
              className="hidden"
            />

            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-rose-300 px-4 text-xs font-semibold text-rose-600 hover:bg-rose-500/10 dark:border-rose-900/50 dark:text-rose-400"
            >
              <BiIcon name="trash3" className="text-xs" />
              Reset workspace data
            </button>
          </div>
        </div>
      </section>

      {confirmClearOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--df-backdrop)' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-data-title"
        >
          <div className="w-full max-w-sm rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-6">
            <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
              <BiIcon name="exclamation-triangle" className="text-base shrink-0" />
              <h3 id="clear-data-title" className="font-display text-base font-bold text-[var(--df-text)]">
                Clear all Ekagra workspace data?
              </h3>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--df-text-muted)]">
              {authStatus === 'authenticated'
                ? 'This removes all tasks, scheduled blocks, habits, and focus history from your Supabase cloud account.'
                : 'This clears all tasks, scheduled blocks, habits, focus history, and assistant conversations from this device.'}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmClearOpen(false)}
                className="rounded-xl border border-[var(--df-border)] px-4 py-2 text-xs font-medium text-[var(--df-text-muted)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmClear()}
                className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white"
              >
                Yes, clear all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
