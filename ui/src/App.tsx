import { StoreProvider, useStore } from './store';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import Providers from './components/Providers';
import ModelTests from './components/ModelTests';
import FailoverChains from './components/FailoverChains';
import ProxyEndpoints from './components/ProxyEndpoints';
import LiveStatus from './components/LiveStatus';
import Logs from './components/Logs';

function PageContent() {
  const { state } = useStore();

  const pages = {
    dashboard: <Dashboard />,
    providers: <Providers />,
    'model-tests': <ModelTests />,
    chains: <FailoverChains />,
    endpoints: <ProxyEndpoints />,
    'live-status': <LiveStatus />,
    logs: <Logs />,
  };

  return pages[state.currentPage] || <Dashboard />;
}

function AppLayout() {
  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-6 lg:p-8">
          <PageContent />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <AppLayout />
    </StoreProvider>
  );
}
