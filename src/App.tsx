import React from 'react';
import { AuthGuard } from './components/auth/AuthGuard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell } from './components/layout/AppShell';
import { ActivityModal } from './components/modals/ActivityModal';
import { TaskModal } from './components/modals/TaskModal';
import { ToastContainer } from './components/ui/ToastContainer';
import { AuthProvider } from './contexts/AuthContext';
import { DayFlowProvider, useDayFlow } from './context/DayFlowContext';
import { CalendarView } from './views/CalendarView';
import { CaptureView } from './views/CaptureView';
import { FocusView } from './views/FocusView';
import { InsightsView } from './views/InsightsView';
import { PlanView } from './views/PlanView';
import { SettingsView } from './views/SettingsView';

const DayFlowWorkspace: React.FC = () => {
  const {
    activePage,
    isQuickAddTaskOpen,
    setQuickAddTaskOpen,
    quickActivitySheet,
    closeQuickActivitySheet,
  } = useDayFlow();

  const renderPage = () => {
    switch (activePage) {
      case 'plan':
        return <PlanView />;
      case 'focus':
        return <FocusView />;
      case 'capture':
        return <CaptureView />;
      case 'calendar':
        return <CalendarView />;
      case 'insights':
        return <InsightsView />;
      case 'settings':
        return <SettingsView />;
      default:
        return <PlanView />;
    }
  };

  return (
    <AppShell>
      {renderPage()}
      <ActivityModal
        isOpen={quickActivitySheet.isOpen}
        initialDate={quickActivitySheet.initialDate}
        initialStartTime={quickActivitySheet.initialStartTime}
        initialEndTime={quickActivitySheet.initialEndTime}
        initialTitle={quickActivitySheet.initialTitle}
        initialDescription={quickActivitySheet.initialDescription}
        initialCategory={quickActivitySheet.initialCategory}
        editingActivity={quickActivitySheet.editingActivity}
        onClose={closeQuickActivitySheet}
      />
      <TaskModal
        isOpen={isQuickAddTaskOpen}
        onClose={() => setQuickAddTaskOpen(false)}
      />
      <ToastContainer />
    </AppShell>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AuthGuard>
          <DayFlowProvider>
            <DayFlowWorkspace />
          </DayFlowProvider>
        </AuthGuard>
      </AuthProvider>
    </ErrorBoundary>
  );
}
