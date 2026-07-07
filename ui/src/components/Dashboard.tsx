import {
  Activity,
  Server,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Zap,
  TrendingUp,
  Clock,
} from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../utils/cn';

function StatCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-lg transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="text-2xl font-bold mt-1 text-slate-800">{value}</p>
          {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
        </div>
        <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', color)}>
          {icon}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { state } = useStore();
  const onlineProviders = state.providers.filter(p => p.status === 'online').length;
  const totalModels = state.providers.reduce((sum, p) => sum + p.models.length, 0);
  const enabledChains = state.chains.filter(c => c.enabled).length;
  const totalRequests = state.chains.reduce((sum, c) => sum + c.totalRequests, 0);
  const totalFailovers = state.chains.reduce((sum, c) => sum + c.failoverCount, 0);
  const avgSuccessRate = state.chains.length
    ? (state.chains.reduce((sum, c) => sum + c.successRate, 0) / state.chains.length).toFixed(1)
    : '0';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-slate-800">仪表盘</h2>
        <p className="text-slate-500 mt-1">模型故障转移代理系统运行概览</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          icon={<Server size={20} className="text-blue-600" />}
          label="在线提供商"
          value={`${onlineProviders} / ${state.providers.length}`}
          sub={`共 ${totalModels} 个模型`}
          color="bg-blue-50"
        />
        <StatCard
          icon={<GitBranch size={20} className="text-violet-600" />}
          label="故障转移链"
          value={enabledChains}
          sub={`共 ${state.chains.length} 条链`}
          color="bg-violet-50"
        />
        <StatCard
          icon={<TrendingUp size={20} className="text-emerald-600" />}
          label="总请求数"
          value={totalRequests.toLocaleString()}
          sub={`故障转移 ${totalFailovers} 次`}
          color="bg-emerald-50"
        />
        <StatCard
          icon={<Zap size={20} className="text-amber-600" />}
          label="平均成功率"
          value={`${avgSuccessRate}%`}
          sub="所有转移链"
          color="bg-amber-50"
        />
      </div>

      {/* Provider Status & Failover Chains */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Provider Status */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Activity size={18} className="text-slate-600" />
            <h3 className="font-semibold text-slate-800">提供商状态</h3>
          </div>
          <div className="divide-y divide-slate-50">
            {state.providers.map(p => (
              <div key={p.id} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    'w-2.5 h-2.5 rounded-full',
                    p.status === 'online' ? 'bg-emerald-500 shadow-sm shadow-emerald-300' :
                    p.status === 'offline' ? 'bg-red-500 shadow-sm shadow-red-300' :
                    'bg-slate-400'
                  )} />
                  <div>
                    <p className="font-medium text-slate-700 text-sm">{p.name}</p>
                    <p className="text-xs text-slate-400">{p.baseUrl}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-slate-400">{p.models.length} 模型</span>
                  {p.latency !== undefined && (
                    <span className={cn(
                      'text-xs font-mono px-2 py-0.5 rounded-full',
                      p.latency < 300 ? 'bg-emerald-50 text-emerald-600' :
                      p.latency < 500 ? 'bg-amber-50 text-amber-600' :
                      'bg-red-50 text-red-600'
                    )}>
                      {p.latency}ms
                    </span>
                  )}
                  {p.status === 'online' ? (
                    <CheckCircle2 size={16} className="text-emerald-500" />
                  ) : p.status === 'offline' ? (
                    <XCircle size={16} className="text-red-500" />
                  ) : (
                    <AlertTriangle size={16} className="text-slate-400" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Failover Chain Visual */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <GitBranch size={18} className="text-slate-600" />
            <h3 className="font-semibold text-slate-800">故障转移链概览</h3>
          </div>
          <div className="p-5 space-y-4">
            {state.chains.map(chain => {
              const getProvider = (pid: string) => state.providers.find(p => p.id === pid);
              return (
                <div key={chain.id} className={cn(
                  'rounded-lg border p-4',
                  chain.enabled ? 'border-slate-200 bg-slate-50/50' : 'border-slate-200 bg-slate-100 opacity-60'
                )}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'w-2 h-2 rounded-full',
                        chain.enabled ? 'bg-emerald-500' : 'bg-slate-400'
                      )} />
                      <span className="font-medium text-sm text-slate-700">{chain.name}</span>
                    </div>
                    <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full font-mono">
                      {chain.proxyModelName}
                    </span>
                  </div>
                  {/* Flow */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {chain.models.map((m, i) => {
                      const provider = getProvider(m.providerId);
                      const isOnline = provider?.status === 'online';
                      return (
                        <div key={i} className="flex items-center gap-1.5">
                          <div className={cn(
                            'text-xs px-2.5 py-1 rounded-md border flex items-center gap-1.5',
                            !m.enabled ? 'bg-slate-100 border-slate-200 text-slate-400' :
                            isOnline ? 'bg-white border-slate-200 text-slate-700' :
                            'bg-red-50 border-red-200 text-red-600'
                          )}>
                            <div className={cn(
                              'w-1.5 h-1.5 rounded-full',
                              !m.enabled ? 'bg-slate-300' :
                              isOnline ? 'bg-emerald-500' : 'bg-red-500'
                            )} />
                            <span className="font-mono">{m.modelName}</span>
                          </div>
                          {i < chain.models.length - 1 && (
                            <ArrowRight size={12} className="text-slate-300 flex-shrink-0" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {state.chains.length === 0 && (
              <div className="text-center py-8 text-slate-400">
                <GitBranch size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无故障转移链</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Logs */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <Clock size={18} className="text-slate-600" />
          <h3 className="font-semibold text-slate-800">最近请求日志</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="text-left px-5 py-2.5 font-medium">时间</th>
                <th className="text-left px-5 py-2.5 font-medium">转移链</th>
                <th className="text-left px-5 py-2.5 font-medium">调用路径</th>
                <th className="text-left px-5 py-2.5 font-medium">状态</th>
                <th className="text-left px-5 py-2.5 font-medium">延迟</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {state.logs.slice(0, 6).map(log => {
                const time = new Date(log.timestamp);
                const timeStr = time.toLocaleTimeString('zh-CN');
                return (
                  <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-slate-500 font-mono text-xs">{timeStr}</td>
                    <td className="px-5 py-3 text-slate-700">{log.chainName}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1 flex-wrap">
                        {log.failedModels.map((m, i) => (
                          <span key={i} className="text-xs bg-red-50 text-red-500 px-1.5 py-0.5 rounded line-through font-mono">{m}</span>
                        ))}
                        {log.failedModels.length > 0 && <ArrowRight size={10} className="text-slate-300" />}
                        <span className={cn(
                          'text-xs px-1.5 py-0.5 rounded font-mono',
                          log.status === 'success' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
                        )}>
                          {log.finalModel || '全部失败'}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {log.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                          <CheckCircle2 size={12} /> 成功
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-red-500">
                          <XCircle size={12} /> 失败
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{log.latency}ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
