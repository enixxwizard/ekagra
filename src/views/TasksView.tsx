import React, { useMemo, useState } from 'react';
import {
  CalendarPlus,
  Check,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { ScheduleTaskModal } from '../components/modals/ScheduleTaskModal';
import { TaskModal } from '../components/modals/TaskModal';
import { useDayFlow } from '../context/DayFlowContext';
import { ActivityCategory, PriorityLevel, TaskItem } from '../types/dayflow';
import { formatShortDate, getTodayISO } from '../utils/dateTime';

type TaskSectionTab = 'all' | 'today' | 'upcoming' | 'completed';

const CATEGORIES: ('All' | ActivityCategory)[] = [
  'All',
  'Work',
  'Study',
  'Health',
  'Personal',
  'Deep Focus',
  'Admin',
];

export const TasksView: React.FC = () => {
  const { state, toggleTask, deleteTask, pushToast } = useDayFlow();
  const todayISO = getTodayISO();

  const [section, setSection] = useState<TaskSectionTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | ActivityCategory>('All');
  const [priorityFilter, setPriorityFilter] = useState<'all' | PriorityLevel>('all');

  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [taskToSchedule, setTaskToSchedule] = useState<TaskItem | null>(null);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return state.tasks.filter((task) => {
      if (categoryFilter !== 'All' && task.category !== categoryFilter) return false;
      if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
      if (q) {
        const hay = `${task.title} ${task.description} ${task.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (section === 'completed') return task.completed;
      if (section === 'today') {
        return !task.completed && (task.dueDate === null || task.dueDate <= todayISO);
      }
      if (section === 'upcoming') {
        return !task.completed && task.dueDate !== null && task.dueDate > todayISO;
      }
      return true;
    });
  }, [state.tasks, categoryFilter, priorityFilter, searchQuery, section, todayISO]);

  const counts = useMemo(() => {
    const todayCount = state.tasks.filter(
      (t) => !t.completed && (t.dueDate === null || t.dueDate <= todayISO)
    ).length;
    const upcomingCount = state.tasks.filter(
      (t) => !t.completed && t.dueDate !== null && t.dueDate > todayISO
    ).length;
    const completedCount = state.tasks.filter((t) => t.completed).length;
    return {
      all: state.tasks.length,
      today: todayCount,
      upcoming: upcomingCount,
      completed: completedCount,
    };
  }, [state.tasks, todayISO]);

  const groupedAll = useMemo(() => {
    if (section !== 'all') return null;
    return {
      today: filteredTasks.filter(
        (t) => !t.completed && (t.dueDate === null || t.dueDate <= todayISO)
      ),
      upcoming: filteredTasks.filter(
        (t) => !t.completed && t.dueDate !== null && t.dueDate > todayISO
      ),
      completed: filteredTasks.filter((t) => t.completed),
    };
  }, [section, filteredTasks, todayISO]);

  const renderTaskRow = (task: TaskItem) => {
    const isOverdue = !task.completed && task.dueDate !== null && task.dueDate < todayISO;

    return (
      <li
        key={task.id}
        className="flex flex-col justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--df-surface-hover)] sm:flex-row sm:items-center"
      >
        <div className="flex items-start gap-3 min-w-0">
          <button
            type="button"
            onClick={() => toggleTask(task.id)}
            aria-label={task.completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border transition-transform active:scale-90 ${
              task.completed
                ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                : 'border-[var(--df-border)] bg-[var(--df-bg)] text-transparent hover:border-[var(--df-border-strong)]'
            }`}
          >
            <Check className="h-4 w-4 stroke-[2.5]" />
          </button>

          <div className="min-w-0">
            <p
              className={`text-sm font-medium ${
                task.completed
                  ? 'line-through text-[var(--df-text-subtle)]'
                  : 'text-[var(--df-text)]'
              }`}
            >
              {task.title}
            </p>
            {task.description && (
              <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
                {task.description}
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--df-text-muted)] tabular-nums">
              {task.category} · {task.priority} ·{' '}
              <span className="font-mono">{task.estimatedMinutes}m</span>
              {task.dueDate && (
                <span className={isOverdue ? ' font-medium text-rose-600' : ''}>
                  {' '}
                  · {isOverdue ? `Overdue (${formatShortDate(task.dueDate)})` : `Due ${formatShortDate(task.dueDate)}`}
                </span>
              )}
              {task.scheduledActivityId && (
                <span className="font-medium text-[var(--df-accent-soft-fg)]"> · On timeline</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 pl-11 sm:pl-0 shrink-0">
          {!task.completed && (
            <button
              type="button"
              onClick={() => setTaskToSchedule(task)}
              className="inline-flex h-9 items-center gap-1 rounded-xl border border-[var(--df-border)] px-3 text-xs font-medium text-[var(--df-text)] hover:border-[var(--df-border-strong)] whitespace-nowrap"
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              Schedule
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setEditingTask(task);
              setTaskModalOpen(true);
            }}
            aria-label={`Edit ${task.title}`}
            className="rounded-lg p-2 text-[var(--df-text-subtle)] hover:text-[var(--df-text)]"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              deleteTask(task.id);
              pushToast({ type: 'info', title: 'Task removed', description: task.title });
            }}
            aria-label={`Delete ${task.title}`}
            className="rounded-lg p-2 text-[var(--df-text-subtle)] hover:text-rose-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-4 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-[var(--df-surface-subtle)] p-1">
          {(
            [
              { id: 'all', label: `All (${counts.all})` },
              { id: 'today', label: `Today (${counts.today})` },
              { id: 'upcoming', label: `Upcoming (${counts.upcoming})` },
              { id: 'completed', label: `Done (${counts.completed})` },
            ] as { id: TaskSectionTab; label: string }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSection(tab.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                section === tab.id
                  ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                  : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:w-44 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--df-text-subtle)]" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tasks..."
              className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] py-2 pr-3 pl-8 text-xs text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
            />
          </div>

          <select
            aria-label="Filter by category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as 'All' | ActivityCategory)}
            className="rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-2 text-xs text-[var(--df-text)]"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c === 'All' ? 'All tags' : c}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by priority"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as 'all' | PriorityLevel)}
            className="rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-2 text-xs text-[var(--df-text)]"
          >
            <option value="all">All priorities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <button
            type="button"
            onClick={() => {
              setEditingTask(null);
              setTaskModalOpen(true);
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-3.5 text-xs font-semibold text-[var(--df-cta-fg)] whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            New task
          </button>
        </div>
      </div>

      {filteredTasks.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-[var(--df-border-strong)] py-12 text-center">
          <p className="font-display text-base font-semibold text-[var(--df-text)]">No matching tasks</p>
          <p className="mt-1 text-xs text-[var(--df-text-muted)]">Add one or clear your filters.</p>
          <button
            type="button"
            onClick={() => {
              setEditingTask(null);
              setTaskModalOpen(true);
            }}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-4 py-2 text-xs font-semibold text-[var(--df-accent-fg)]"
          >
            <Plus className="h-3.5 w-3.5" />
            New task
          </button>
        </div>
      ) : groupedAll ? (
        <div className="space-y-4">
          {[
            { key: 'today', title: 'Today & Overdue', items: groupedAll.today },
            { key: 'upcoming', title: 'Upcoming', items: groupedAll.upcoming },
            { key: 'completed', title: 'Completed', items: groupedAll.completed },
          ]
            .filter((g) => g.items.length > 0)
            .map((group) => (
              <section
                key={group.key}
                className="overflow-hidden rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)]"
              >
                <div className="flex items-center justify-between border-b border-[var(--df-border)] bg-[var(--df-bg)] px-4 py-2.5">
                  <h3 className="text-xs font-semibold text-[var(--df-text-muted)]">
                    {group.title}
                  </h3>
                  <span className="font-mono text-xs tabular-nums text-[var(--df-text-muted)]">
                    {group.items.length}
                  </span>
                </div>
                <ul className="divide-y divide-[var(--df-border)]">
                  {group.items.map(renderTaskRow)}
                </ul>
              </section>
            ))}
        </div>
      ) : (
        <section className="overflow-hidden rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)]">
          <ul className="divide-y divide-[var(--df-border)]">
            {filteredTasks.map(renderTaskRow)}
          </ul>
        </section>
      )}

      <TaskModal
        isOpen={taskModalOpen}
        editingTask={editingTask}
        onClose={() => setTaskModalOpen(false)}
      />

      <ScheduleTaskModal
        task={taskToSchedule}
        onClose={() => setTaskToSchedule(null)}
      />
    </div>
  );
};
