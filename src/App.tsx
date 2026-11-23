import React from 'react';
import { AuthGuard } from './components/auth/AuthGuard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell } from './components/layout/AppShell';
import { ActivityModal } from './components/modals/ActivityModal';
import { FullScreenReminderOverlay } from './components/modals/FullScreenReminderOverlay';
import { TaskModal } from './components/modals/TaskModal';
import { EkuAssistant } from './components/eku/EkuAssistant';
import { ToastContainer } from './components/ui/ToastContainer';
import { AuthProvider } from './contexts/AuthContext';
import { DayFlowProvider, useDayFlow } from './context/DayFlowContext';
import { CalendarView } from './views/CalendarView';
import { CaptureView } from './views/CaptureView';
import { FocusView } from './views/FocusView';
import { InsightsView } from './views/InsightsView';
import { LibraryView } from './views/LibraryView';
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
      case 'library':
        return <LibraryView />;
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
      <FullScreenReminderOverlay />
      <EkuAssistant />
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
