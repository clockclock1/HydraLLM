import { StoreProvider, useStore } from './store';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import Providers from './components/Providers';
import ModelTests from './components/ModelTests';
import FailoverChains from './components/FailoverChains';
import ModelStats from './components/ModelStats';
import ProxyEndpoints from './components/ProxyEndpoints';
import LiveStatus from './components/LiveStatus';
import Logs from './components/Logs';
import Login from './components/Login';

function PageContent() {
  const { state } = useStore();

  const pages = {
    dashboard: <Dashboard />,
    providers: <Providers />,
    'model-tests': <ModelTests />,
    chains: <FailoverChains />,
    'model-stats': <ModelStats />,
    endpoints: <ProxyEndpoints />,
    'live-status': <LiveStatus />,
    logs: <Logs />,
  };

  return (
    <div key={state.currentPage} className="page-motion">
      {pages[state.currentPage] || <Dashboard />}
    </div>
  );
}

function AppLayout() {
  const { state } = useStore();

  if (!state.authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-sm text-slate-300">
        正在检查登录状态...
      </div>
    );
  }

  if (!state.authenticated) {
    return <Login />;
  }

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-6 transition-all duration-300 lg:p-8">
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
