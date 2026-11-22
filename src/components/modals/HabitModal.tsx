import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { HabitFormInput, useDayFlow } from '../../context/DayFlowContext';
import { ActivityCategory, ActivityColor, HabitFrequency, HabitItem } from '../../types/dayflow';
import { ACTIVITY_COLORS } from '../../utils/colors';

interface HabitModalProps {
  isOpen: boolean;
  editingHabit?: HabitItem | null;
  onClose: () => void;
}

const CATEGORIES: ActivityCategory[] = [
  'Health',
  'Deep Focus',
  'Study',
  'Work',
  'Personal',
  'Admin',
];

const COLORS: ActivityColor[] = ['emerald', 'indigo', 'sky', 'amber', 'violet', 'rose', 'slate'];

export const HabitModal: React.FC<HabitModalProps> = ({ isOpen, editingHabit, onClose }) => {
  const { saveHabit, pushToast } = useDayFlow();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<HabitFrequency>('daily');
  const [targetPerWeek, setTargetPerWeek] = useState(3);
  const [category, setCategory] = useState<ActivityCategory>('Health');
  const [color, setColor] = useState<ActivityColor>('emerald');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    if (editingHabit) {
      setTitle(editingHabit.title);
      setDescription(editingHabit.description);
      setFrequency(editingHabit.frequency);
      setTargetPerWeek(editingHabit.targetPerWeek);
      setCategory(editingHabit.category);
      setColor(editingHabit.color);
    } else {
      setTitle('');
      setDescription('');
      setFrequency('daily');
      setTargetPerWeek(3);
      setCategory('Health');
      setColor('emerald');
    }
    setError('');
  }, [isOpen, editingHabit]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Give your habit a name.');
      return;
    }

    const input: HabitFormInput = {
      id: editingHabit?.id,
      title: title.trim(),
      description: description.trim(),
      frequency,
      targetPerWeek: frequency === 'daily' ? 7 : Math.max(1, Math.min(7, targetPerWeek)),
      category,
      color,
    };

    saveHabit(input);
    pushToast({
      type: 'success',
      title: editingHabit ? 'Habit updated' : 'Habit created',
      description: input.title,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      style={{ backgroundColor: 'var(--df-backdrop)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="habit-modal-title"
    >
      <div className="animate-sheet-up w-full rounded-t-3xl border border-[var(--df-border)] bg-[var(--df-surface)] sm:max-w-md sm:rounded-3xl">
        <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-[var(--df-border)] sm:hidden" />

        <div className="flex items-center justify-between px-6 pt-4 pb-2 sm:pt-5">
          <h2 id="habit-modal-title" className="font-display text-lg font-semibold text-[var(--df-text)]">
            {editingHabit ? 'Edit habit' : 'New habit'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--df-text-muted)] hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
          >
            <X className="h-4 w-4" />
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
            placeholder="e.g., 20 min morning walk"
            className="w-full rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 py-3 text-base font-medium text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none"
          />

          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Cue or note (optional)"
            className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 py-2.5 text-sm text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)]"
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="h-freq" className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                Cadence
              </label>
              <select
                id="h-freq"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as HabitFrequency)}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)]"
              >
                <option value="daily">Every day</option>
                <option value="weekly">Weekly goal</option>
              </select>
            </div>

            {frequency === 'weekly' ? (
              <div>
                <label htmlFor="h-target" className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                  Days / week
                </label>
                <input
                  id="h-target"
                  type="number"
                  min={1}
                  max={7}
                  value={targetPerWeek}
                  onChange={(e) => setTargetPerWeek(Number(e.target.value))}
                  className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 font-mono text-sm tabular-nums text-[var(--df-text)]"
                />
              </div>
            ) : (
              <div>
                <label htmlFor="h-cat" className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                  Tag
                </label>
                <select
                  id="h-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ActivityCategory)}
                  className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)]"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => {
              const token = ACTIVITY_COLORS[c];
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={token.label}
                  className={`flex h-8 w-8 items-center justify-center rounded-xl border ${
                    color === c
                      ? 'border-[var(--df-border-strong)] ring-2 ring-[var(--df-accent)]'
                      : 'border-[var(--df-border)]'
                  }`}
                >
                  <span className={`h-4 w-4 rounded-md ${token.swatch}`} />
                </button>
              );
            })}
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
              {editingHabit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
