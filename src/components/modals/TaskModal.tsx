import React, { useEffect, useState } from 'react';
import { BiIcon } from '../ui/BiIcon';
import { TaskFormInput, useDayFlow } from '../../context/DayFlowContext';
import { ActivityCategory, PriorityLevel, TaskItem } from '../../types/dayflow';
import { getTodayISO } from '../../utils/dateTime';

interface TaskModalProps {
  isOpen: boolean;
  editingTask?: TaskItem | null;
  onClose: () => void;
}

const CATEGORIES: ActivityCategory[] = [
  'Work',
  'Study',
  'Health',
  'Personal',
  'Deep Focus',
  'Admin',
];

export const TaskModal: React.FC<TaskModalProps> = ({ isOpen, editingTask, onClose }) => {
  const { saveTask, pushToast } = useDayFlow();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<PriorityLevel>('medium');
  const [category, setCategory] = useState<ActivityCategory>('Work');
  const [dueDate, setDueDate] = useState<string>(getTodayISO());
  const [hasDueDate, setHasDueDate] = useState(true);
  const [estimatedMinutes, setEstimatedMinutes] = useState(45);
  const [showMore, setShowMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    if (editingTask) {
      setTitle(editingTask.title);
      setDescription(editingTask.description);
      setPriority(editingTask.priority);
      setCategory(editingTask.category);
      setDueDate(editingTask.dueDate ?? getTodayISO());
      setHasDueDate(editingTask.dueDate !== null);
      setEstimatedMinutes(editingTask.estimatedMinutes || 45);
      setShowMore(Boolean(editingTask.description));
    } else {
      setTitle('');
      setDescription('');
      setPriority('medium');
      setCategory('Work');
      setDueDate(getTodayISO());
      setHasDueDate(true);
      setEstimatedMinutes(45);
      setShowMore(false);
    }
    setError('');
  }, [isOpen, editingTask]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Give your task a name.');
      return;
    }

    const payload: TaskFormInput = {
      id: editingTask?.id,
      title: title.trim(),
      description: description.trim(),
      priority,
      category,
      dueDate: hasDueDate && dueDate ? dueDate : null,
      estimatedMinutes: Math.max(5, Math.min(480, Number(estimatedMinutes) || 30)),
    };

    saveTask(payload);
    pushToast({
      type: 'success',
      title: editingTask ? 'Task updated' : 'Task added',
      description: payload.title,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      style={{ backgroundColor: 'var(--df-backdrop)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-modal-title"
    >
      <div className="animate-sheet-up w-full rounded-t-3xl border border-[var(--df-border)] bg-[var(--df-surface)] sm:max-w-md sm:rounded-3xl">
        <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-[var(--df-border)] sm:hidden" />

        <div className="flex items-center justify-between px-6 pt-4 pb-2 sm:pt-5">
          <h2 id="task-modal-title" className="font-display text-lg font-semibold text-[var(--df-text)]">
            {editingTask ? 'Edit task' : 'New task'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--df-text-muted)] hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
          >
            <BiIcon name="x-lg" className="text-[14px]" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 pt-2 pb-6">
          {error && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </p>
          )}

          <input
            type="text"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            className="w-full rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 py-3 text-base font-medium text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none"
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="t-due" className="text-xs font-medium text-[var(--df-text-muted)]">
                  Due
                </label>
                <label className="flex items-center gap-1 text-[11px] text-[var(--df-text-muted)]">
                  <input
                    type="checkbox"
                    checked={hasDueDate}
                    onChange={(e) => setHasDueDate(e.target.checked)}
                    className="rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                  />
                  Date
                </label>
              </div>
              <input
                id="t-due"
                type="date"
                disabled={!hasDueDate}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)] disabled:opacity-50"
              />
            </div>

            <div>
              <label htmlFor="t-est" className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                Est. minutes
              </label>
              <input
                id="t-est"
                type="number"
                min={5}
                max={480}
                step={5}
                value={estimatedMinutes}
                onChange={(e) => setEstimatedMinutes(Number(e.target.value))}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 font-mono text-xs tabular-nums text-[var(--df-text)]"
              />
            </div>
          </div>

          <div className="border-t border-[var(--df-border)] pt-3">
            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              className="flex w-full items-center justify-between text-xs font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
            >
              <span>{showMore ? 'Hide details' : 'Notes, category & priority'}</span>
              <BiIcon name={showMore ? 'chevron-up' : 'chevron-down'} className="text-[14px]" />
            </button>

            {showMore && (
              <div className="mt-3 space-y-3">
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional notes..."
                  className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                />
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as ActivityCategory)}
                    className="rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as PriorityLevel)}
                    className="rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                  >
                    <option value="high">High priority</option>
                    <option value="medium">Medium priority</option>
                    <option value="low">Low priority</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-xl border border-[var(--df-border)] px-4 text-sm font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-11 rounded-xl bg-[var(--df-cta)] px-5 text-sm font-semibold text-[var(--df-cta-fg)]"
            >
              {editingTask ? 'Save' : 'Add task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
