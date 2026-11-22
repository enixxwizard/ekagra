import React, { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useDayFlow } from '../context/DayFlowContext';
import { calculateAnalytics } from '../utils/analytics';
import { CATEGORY_CHART_COLORS } from '../utils/colors';
import { formatDurationCompact, getTodayISO } from '../utils/dateTime';

function readThemeVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

export const AnalyticsView: React.FC = () => {
  const { state, resolvedTheme, setActivePage } = useDayFlow();
  const todayISO = getTodayISO();

  const analytics = useMemo(() => calculateAnalytics(state, todayISO), [state, todayISO]);

  const hasAnyScheduleData = state.activities.length > 0;
  const hasAnyFocusData = analytics.focusByCategory.length > 0;

  const chartColors = useMemo(() => {
    const border = readThemeVar('--df-border', '#E8E5DC');
    const borderStrong = readThemeVar('--df-border-strong', '#D3CFC2');
    const surface = readThemeVar('--df-surface', '#FFFFFF');
    const text = readThemeVar('--df-text', '#20211F');
    const textMuted = readThemeVar('--df-text-muted', '#6B6D67');
    const accent = readThemeVar('--df-accent', '#B9E769');
    return {
      gridColor: border,
      textColor: textMuted,
      plannedFill: borderStrong,
      accent,
      tooltipStyle: {
        backgroundColor: surface,
        borderColor: border,
        color: text,
        borderRadius: '14px',
        fontSize: '12px',
      },
    };
  }, [resolvedTheme]);

  return (
    <div className="space-y-6">
      {/* Clean 4-column Summary Strip */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
          <p className="text-xs font-medium text-[var(--df-text-muted)]">
            Today&apos;s pace
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[var(--df-text)]">
            {analytics.todayCompletionRate}%
          </p>
          <p className="mt-1 text-xs text-[var(--df-text-muted)]">
            {analytics.weeklyCompletionTrendDelta === null
              ? 'Tracking first week'
              : `${analytics.weeklyCompletionTrendDelta >= 0 ? '+' : ''}${
                  analytics.weeklyCompletionTrendDelta
                }% vs last week`}
          </p>
        </div>

        <div className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
          <p className="text-xs font-medium text-[var(--df-text-muted)]">
            Total focus
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[var(--df-text)]">
            {analytics.totalFocusHoursAllTime}h
          </p>
          <p className="mt-1 text-xs text-[var(--df-text-muted)] tabular-nums">
            {state.focusSessions.filter((s) => s.mode === 'focus').length} sessions
          </p>
        </div>

        <div className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
          <p className="text-xs font-medium text-[var(--df-text-muted)]">
            Habit streak avg
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[var(--df-text)]">
            {state.habits.length > 0 ? `${analytics.habitConsistencyPercent}%` : '—'}
          </p>
          <p className="mt-1 text-xs text-[var(--df-text-muted)]">
            Last 7 days
          </p>
        </div>

        <div className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
          <p className="text-xs font-medium text-[var(--df-text-muted)]">
            Tasks done
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[var(--df-text)]">
            {analytics.totalCompletedTasks}
          </p>
          <p className="mt-1 text-xs text-[var(--df-text-muted)] tabular-nums">
            of {analytics.totalTasks} total
          </p>
        </div>
      </section>

      {/* Peak Day Highlight */}
      <section className="flex flex-col justify-between gap-2 rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] px-5 py-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-medium text-[var(--df-text-muted)]">
            Best day this week
          </p>
          <p className="mt-0.5 font-display text-base font-bold text-[var(--df-text)]">
            {analytics.mostProductiveDay
              ? `${analytics.mostProductiveDay.label} · ${analytics.mostProductiveDay.focusHours}h focused`
              : 'No completed activity yet'}
          </p>
        </div>
      </section>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 lg:col-span-6">
          <div className="border-b border-[var(--df-border)] pb-3">
            <h2 className="text-sm font-semibold text-[var(--df-text)]">
              Planned vs. Focused Hours
            </h2>
          </div>

          {!hasAnyScheduleData && !hasAnyFocusData ? (
            <div className="flex h-60 flex-col items-center justify-center text-center">
              <p className="text-sm font-medium text-[var(--df-text)]">No schedule or focus data yet</p>
              <button
                type="button"
                onClick={() => setActivePage('calendar')}
                className="mt-3 rounded-xl bg-[var(--df-accent)] px-4 py-2 text-xs font-semibold text-[var(--df-accent-fg)]"
              >
                Plan your week
              </button>
            </div>
          ) : (
            <div className="mt-4 h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.weeklySeries} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.gridColor} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: chartColors.textColor, fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: chartColors.textColor, fontSize: 12 }} axisLine={false} tickLine={false} unit="h" />
                  <Tooltip contentStyle={chartColors.tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar
                    dataKey="plannedHours"
                    name="Planned (h)"
                    fill={chartColors.plannedFill}
                    radius={[6, 6, 0, 0]}
                  />
                  <Bar
                    dataKey="actualFocusHours"
                    name="Focused (h)"
                    fill={chartColors.accent}
                    radius={[6, 6, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 lg:col-span-6">
          <div className="border-b border-[var(--df-border)] pb-3">
            <h2 className="text-sm font-semibold text-[var(--df-text)]">
              Weekly Completion Trend (%)
            </h2>
          </div>

          {!hasAnyScheduleData ? (
            <div className="flex h-60 flex-col items-center justify-center text-center">
              <p className="text-sm font-medium text-[var(--df-text)]">Nothing scheduled yet</p>
              <button
                type="button"
                onClick={() => setActivePage('plan')}
                className="mt-3 rounded-xl bg-[var(--df-accent)] px-4 py-2 text-xs font-semibold text-[var(--df-accent-fg)]"
              >
                Add to today
              </button>
            </div>
          ) : (
            <div className="mt-4 h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics.weeklySeries} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.gridColor} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: chartColors.textColor, fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fill: chartColors.textColor, fontSize: 12 }} axisLine={false} tickLine={false} unit="%" />
                  <Tooltip contentStyle={chartColors.tooltipStyle} />
                  <Area
                    type="monotone"
                    dataKey="completionRate"
                    name="Done %"
                    stroke={chartColors.accent}
                    fill={chartColors.accent}
                    fillOpacity={0.28}
                    strokeWidth={2.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 lg:col-span-12">
          <div className="border-b border-[var(--df-border)] pb-3">
            <h2 className="text-sm font-semibold text-[var(--df-text)]">
              Where your focus went
            </h2>
          </div>

          {!hasAnyFocusData ? (
            <div className="flex h-52 flex-col items-center justify-center text-center">
              <p className="text-sm font-medium text-[var(--df-text)]">No focus sessions recorded yet</p>
              <button
                type="button"
                onClick={() => setActivePage('focus')}
                className="mt-3 rounded-xl bg-[var(--df-accent)] px-4 py-2 text-xs font-semibold text-[var(--df-accent-fg)]"
              >
                Start a focus timer
              </button>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 items-center gap-6 md:grid-cols-12">
              <div className="h-56 md:col-span-5">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={analytics.focusByCategory}
                      dataKey="minutes"
                      nameKey="category"
                      innerRadius={52}
                      outerRadius={84}
                      paddingAngle={3}
                    >
                      {analytics.focusByCategory.map((entry) => (
                        <Cell
                          key={entry.category}
                          fill={CATEGORY_CHART_COLORS[entry.category] ?? chartColors.accent}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={chartColors.tooltipStyle}
                      formatter={(value) => [`${value} min`, 'Focused']}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="divide-y divide-[var(--df-border)] md:col-span-7">
                {analytics.focusByCategory.map((item) => (
                  <div key={item.category} className="flex items-center justify-between py-2.5 text-sm">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-3 w-3 rounded-full shrink-0"
                        style={{
                          backgroundColor:
                            CATEGORY_CHART_COLORS[item.category] ?? chartColors.accent,
                        }}
                      />
                      <span className="font-medium text-[var(--df-text)]">
                        {item.category}
                      </span>
                    </div>
                    <span className="font-mono text-xs tabular-nums text-[var(--df-text-muted)]">
                      {formatDurationCompact(item.minutes)} ({item.hours}h)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
