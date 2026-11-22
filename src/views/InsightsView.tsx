import React from 'react';
import { useDayFlow } from '../context/DayFlowContext';
import { AnalyticsView } from './AnalyticsView';
import { HabitsView } from './HabitsView';
import { TasksView } from './TasksView';

export const InsightsView: React.FC = () => {
  const { insightsTab, setInsightsTab } = useDayFlow();

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[var(--df-text)]">
            Insights
          </h1>
          <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
            Real numbers from your schedule, habits, and focus sessions.
          </p>
        </div>

        <div className="inline-flex items-center rounded-xl bg-[var(--df-surface-subtle)] p-1 self-start">
          {(
            [
              { id: 'overview', label: 'Analytics' },
              { id: 'habits', label: 'Habits' },
              { id: 'tasks', label: 'Tasks' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setInsightsTab(tab.id)}
              className={`min-h-[36px] rounded-lg px-4 text-xs font-semibold transition-colors whitespace-nowrap ${
                insightsTab === tab.id
                  ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                  : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {insightsTab === 'overview' && <AnalyticsView />}
      {insightsTab === 'habits' && <HabitsView />}
      {insightsTab === 'tasks' && <TasksView />}
    </div>
  );
};
