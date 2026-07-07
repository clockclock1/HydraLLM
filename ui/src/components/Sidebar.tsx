import { useState } from 'react';
import {
  LayoutDashboard,
  Server,
  GitBranch,
  Link2,
  ScrollText,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Shield,
  Save,
  RefreshCw,
} from 'lucide-react';
import { useStore } from '../store';
import type { Page } from '../types';
import { cn } from '../utils/cn';

const navItems: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: 'dashboard', label: '仪表盘', icon: <LayoutDashboard size={20} /> },
  { page: 'providers', label: '模型提供商', icon: <Server size={20} /> },
  { page: 'chains', label: '故障转移链', icon: <GitBranch size={20} /> },
  { page: 'endpoints', label: '代理端点', icon: <Link2 size={20} /> },
  { page: 'logs', label: '请求日志', icon: <ScrollText size={20} /> },
  { page: 'settings', label: '队列设置', icon: <SlidersHorizontal size={20} /> },
];

export default function Sidebar() {
  const { state, dispatch, loadConfig, saveConfig } = useStore();
  const [token, setToken] = useState(state.adminToken);
  const collapsed = state.sidebarCollapsed;
  const busy = state.saveStatus === 'loading' || state.saveStatus === 'saving';

  return (
    <aside
      className={cn(
        'h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-white flex flex-col transition-all duration-300 border-r border-slate-700/50 flex-shrink-0',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-slate-700/50">
        <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-violet-600 rounded-lg flex items-center justify-center flex-shrink-0">
          <Shield size={18} className="text-white" />
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <h1 className="text-sm font-bold whitespace-nowrap">Failover Proxy</h1>
            <p className="text-[10px] text-slate-400 whitespace-nowrap">模型故障转移代理</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {navItems.map(({ page, label, icon }) => (
          <button
            key={page}
            onClick={() => dispatch({ type: 'SET_PAGE', page })}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200',
              state.currentPage === page
                ? 'bg-blue-600/20 text-blue-400 shadow-lg shadow-blue-500/5'
                : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
            )}
          >
            <span className="flex-shrink-0">{icon}</span>
            {!collapsed && <span className="whitespace-nowrap">{label}</span>}
          </button>
        ))}
      </nav>

      {!collapsed && (
        <div className="px-3 py-3 border-t border-slate-700/50 space-y-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Admin Token</span>
            <input
              value={token}
              onChange={e => setToken(e.target.value)}
              onBlur={() => dispatch({ type: 'SET_ADMIN_TOKEN', token })}
              className="mt-1 w-full rounded-lg bg-slate-950/50 border border-slate-700 px-3 py-2 text-xs text-slate-200 outline-none focus:border-blue-500"
              placeholder="admin"
              type="password"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                dispatch({ type: 'SET_ADMIN_TOKEN', token });
                loadConfig(token).catch(() => undefined);
              }}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-slate-700/70 px-2 py-2 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
              加载
            </button>
            <button
              onClick={() => {
                dispatch({ type: 'SET_ADMIN_TOKEN', token });
                saveConfig(token).catch(() => undefined);
              }}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-2 py-2 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
            >
              <Save size={13} />
              保存
            </button>
          </div>
          <p className={cn(
            'min-h-4 text-[10px]',
            state.saveStatus === 'error' ? 'text-red-300' :
            state.saveStatus === 'saved' ? 'text-emerald-300' : 'text-slate-500'
          )}>
            {state.saveStatus === 'loading' && '正在加载配置...'}
            {state.saveStatus === 'saving' && '正在保存配置...'}
            {state.saveStatus === 'saved' && '配置已保存'}
            {state.saveStatus === 'error' && (state.saveError || '操作失败')}
            {state.saveStatus === 'idle' && (state.configLoaded ? '已连接后端配置' : '等待加载配置')}
          </p>
        </div>
      )}

      {/* Collapse toggle */}
      <div className="p-2 border-t border-slate-700/50">
        <button
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors text-sm"
        >
          {collapsed ? <ChevronRight size={18} /> : <><ChevronLeft size={18} /><span>收起侧栏</span></>}
        </button>
      </div>
    </aside>
  );
}
