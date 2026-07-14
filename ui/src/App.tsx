import { useState } from 'react';
import { Menu, X } from 'lucide-react';
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (!state.authChecked) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 text-sm text-slate-300">
        正在检查登录状态...
      </div>
    );
  }

  if (!state.authenticated) {
    return <Login />;
  }

  return (
    <div className="min-h-dvh bg-slate-100 md:flex md:h-screen md:overflow-hidden">
      <div className="hidden md:block">
        <Sidebar />
      </div>

      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-slate-200 bg-white/95 px-3 shadow-sm backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 transition-colors hover:bg-slate-100"
          aria-label="打开菜单"
        >
          <Menu size={22} />
        </button>
        <div className="min-w-0 text-center">
          <p className="truncate text-sm font-bold text-slate-900">Failover Proxy</p>
          <p className="truncate text-[11px] text-slate-500">模型故障转移代理</p>
        </div>
        <div className="h-10 w-10" />
      </header>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="关闭菜单"
          />
          <div className="pointer-events-none relative h-full">
            <div className="pointer-events-auto">
              <Sidebar mobile onNavigate={() => setMobileMenuOpen(false)} />
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="pointer-events-auto absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-lg bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
              aria-label="关闭菜单"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-3 pb-8 transition-all duration-300 sm:p-4 md:p-6 lg:p-8">
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
