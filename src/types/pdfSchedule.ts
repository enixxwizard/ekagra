import type {
  ActivityCategory,
  PdfExtractedQuotation,
  PriorityLevel,
  RecurrenceRule,
} from './dayflow';

export type PdfDocumentType = 'daily' | 'weekly' | 'monthly' | 'deadlines' | 'mixed';

export type PdfProvenance = 'explicit' | 'inferred' | 'suggested';

export interface PdfWeeklyPlanItem {
  id: string;
  title: string;
  weekday: number; // 0 = Sun, 1 = Mon .. 6 = Sat
  startTime: string; // HH:mm 24h
  endTime: string; // HH:mm 24h
  recurrenceRule: RecurrenceRule;
  startDate: string | null; // optional YYYY-MM-DD
  endDate: string | null; // optional YYYY-MM-DD
  category: ActivityCategory;
  priority: PriorityLevel;
  sourcePage: number;
  provenance: PdfProvenance;
  notes: string;
  included: boolean;
}

export interface PdfDailyPlanItem {
  id: string;
  title: string;
  date: string | null; // YYYY-MM-DD when explicitly stated or assigned
  dateProvenance: PdfProvenance;
  startTime: string; // HH:mm 24h
  endTime: string; // HH:mm 24h
  timeProvenance: PdfProvenance;
  category: ActivityCategory;
  priority: PriorityLevel;
  sourcePage: number;
  notes: string;
  included: boolean;
}

export interface PdfMonthlyGoalItem {
  id: string;
  month: number; // 1..12
  monthLabel: string; // e.g., "December"
  year: number | null;
  goals: string[];
  category: ActivityCategory;
  sourcePage: number;
  provenance: PdfProvenance;
  included: boolean;
}

export interface PdfDeadlineItem {
  id: string;
  title: string;
  dueDate: string | null; // YYYY-MM-DD or null when omitted in PDF
  dueTime: string | null; // HH:mm or null
  estimatedMinutes: number;
  category: ActivityCategory;
  priority: PriorityLevel;
  kind: 'deadline' | 'exam' | 'assignment';
  sourcePage: number;
  provenance: PdfProvenance;
  notes: string;
  included: boolean;
}

export interface PdfBreakPeriodItem {
  id: string;
  title: string;
  weekdays: number[]; // empty if date-specific
  date: string | null;
  startTime: string; // HH:mm 24h
  endTime: string; // HH:mm 24h
  isOptionalUnavailable: true;
  sourcePage: number;
  provenance: PdfProvenance;
  included: boolean;
}

export interface PdfValidationWarning {
  id: string;
  severity: 'warning' | 'info';
  section: 'weekly' | 'daily' | 'monthly' | 'deadlines' | 'breaks' | 'general';
  message: string;
  sourcePage?: number;
}

export interface ExtractedPdfTable {
  pageNumber: number;
  headers: string[];
  weekdayColumns: Array<{ colIndex: number; weekday: number; label: string }>;
  rows: string[][];
}

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
  layoutText: string;
  tables: ExtractedPdfTable[];
}

export interface PdfPageImagePayload {
  pageNumber: number;
  mimeType: 'image/jpeg' | 'image/png';
  base64Data: string;
}

export interface StructuredPdfPlan {
  fileName: string;
  documentHash: string;
  documentType: PdfDocumentType;
  analysisSource: 'local' | 'gemini' | 'gemini-multimodal';
  dailyPlans: PdfDailyPlanItem[];
  weeklyPlans: PdfWeeklyPlanItem[];
  monthlyGoals: PdfMonthlyGoalItem[];
  deadlines: PdfDeadlineItem[];
  breakPeriods: PdfBreakPeriodItem[];
  quotations: PdfExtractedQuotation[];
  warnings: PdfValidationWarning[];
  cached?: boolean;
}

export interface PdfAutoSyncReviewItem {
  id: string;
  section: 'weekly' | 'daily' | 'deadlines';
  title: string;
  reason: string;
  sourcePage?: number;
}

export interface PdfTimetableDiff {
  hasPreviousImportFromFile: boolean;
  addedTitles: string[];
  changedTitles: string[];
  removedTitles: string[];
}

export interface PdfAutoSyncCommitResult {
  status: 'synced' | 'duplicates_only' | 'needs_review' | 'empty' | 'error';
  persisted: boolean;
  error?: string;
  activitiesAdded: number;
  recurringRulesAdded: number;
  tasksAdded: number;
  notesAdded: number;
  duplicatesSkipped: number;
  conflictsCount: number;
  reviewItems: PdfAutoSyncReviewItem[];
  timetableDiff: PdfTimetableDiff;
}

