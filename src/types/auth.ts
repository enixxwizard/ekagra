import type { Session } from '@supabase/supabase-js';
import type { DayFlowState } from './dayflow';

export type AuthStatus =
  | 'initializing'
  | 'authenticated'
  | 'guest'
  | 'unauthenticated'
  | 'email_confirmation_pending'
  | 'password_recovery'
  | 'error';

export type AuthProviderType = 'google' | 'email';

export interface AuthUser {
  id: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  provider: AuthProviderType;
}

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  session: Session | null;
  error: string | null;
  isSupabaseConfigured: boolean;
}

export interface GuestMigrationSummary {
  hasData: boolean;
  tasksCount: number;
  activitiesCount: number;
  focusSessionsCount: number;
  habitsCount: number;
  notesCount: number;
  quotationsCount: number;
  rawState: DayFlowState | null;
}

export type MigrationStatus =
  | 'idle'
  | 'prompting'
  | 'migrating'
  | 'completed'
  | 'failed';

export interface MigrationResult {
  importedTasks: number;
  importedActivities: number;
  importedFocusSessions: number;
  importedHabits: number;
  importedHabitLogs: number;
  importedNotes: number;
  importedQuotations: number;
  skippedDuplicates: number;
}
