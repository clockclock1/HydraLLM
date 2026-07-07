import {
  ScrollText,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Filter,

  AlertTriangle,
} from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../utils/cn';
import { useState } from 'react';

export default function Logs() {
  const { state } = useStore();
  const [filterStatus, setFilterStatus] = useState<'all' | 'success' | 'failed'>('all');
  const [filterChain, setFilterChain] = useState<string>('all');

  const filteredLogs = state.logs.filter(log => {
    if (filterStatus !== 'all' && log.status !== filterStatus) return false;
    if (filterChain !== 'all' && log.chainName !== filterChain) return false;
    return true;
  });

  const chainNames = [...new Set(state.logs.map(l => l.chainName))];
  const failoverLogs = state.logs.filter(l => l.failedModels.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">请求日志</h2>
        <p className="text-slate-500 mt-1">查看所有通过故障转移代理的请求记录</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
          <p className="text-xs text-slate-500">总日志</p>
          <p className="text-xl font-bold text-slate-800 mt-1">{state.logs.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
          <p className="text-xs text-slate-500">成功请求</p>
          <p className="text-xl font-bold text-emerald-600 mt-1">{state.logs.filter(l => l.status === 'success').length}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
          <p className="text-xs text-slate-500">失败请求</p>
          <p className="text-xl font-bold text-red-500 mt-1">{state.logs.filter(l => l.status === 'failed').length}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
          <p className="text-xs text-slate-500">触发转移</p>
          <p className="text-xl font-bold text-amber-600 mt-1">{failoverLogs.length}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 px-5 py-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-slate-400" />
          <span className="text-sm text-slate-600">筛选：</span>
        </div>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value as 'all' | 'success' | 'failed')}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500"
        >
          <option value="all">所有状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
        </select>
        <select
          value={filterChain}
          onChange={e => setFilterChain(e.target.value)}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500"
        >
          <option value="all">所有转移链</option>
          {chainNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <span className="text-xs text-slate-400 ml-auto">
          显示 {filteredLogs.length} / {state.logs.length} 条
        </span>
      </div>

      {/* Log Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs">
                <th className="text-left px-5 py-3 font-medium">时间</th>
                <th className="text-left px-5 py-3 font-medium">转移链</th>
                <th className="text-left px-5 py-3 font-medium">请求模型</th>
                <th className="text-left px-5 py-3 font-medium">调用路径</th>
                <th className="text-left px-5 py-3 font-medium">状态</th>
                <th className="text-left px-5 py-3 font-medium">延迟</th>
                <th className="text-left px-5 py-3 font-medium">错误信息</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filteredLogs.map(log => {
                const time = new Date(log.timestamp);
                const dateStr = time.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
                const timeStr = time.toLocaleTimeString('zh-CN');
                const hasFailover = log.failedModels.length > 0;
                return (
                  <tr key={log.id} className={cn(
                    'hover:bg-slate-50 transition-colors',
                    log.status === 'failed' && 'bg-red-50/30'
                  )}>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">
                      <span className="text-slate-400">{dateStr}</span> {timeStr}
                    </td>
                    <td className="px-5 py-3 text-slate-700 whitespace-nowrap">{log.chainName}</td>
                    <td className="px-5 py-3">
                      <span className="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-600">{log.originalModel}</span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1 flex-wrap">
                        {log.failedModels.map((m, i) => (
                          <span key={i} className="text-[11px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded line-through font-mono">{m}</span>
                        ))}
                        {hasFailover && <ArrowRight size={10} className="text-slate-300" />}
                        <span className={cn(
                          'text-[11px] px-1.5 py-0.5 rounded font-mono',
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
                          {hasFailover && <AlertTriangle size={10} className="text-amber-500 ml-1" />}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-red-500">
                          <XCircle size={12} /> 失败
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">
                      <span className={cn(
                        log.latency < 1000 ? 'text-emerald-600' :
                        log.latency < 3000 ? 'text-amber-600' : 'text-red-500'
                      )}>
                        {log.latency >= 1000 ? (log.latency / 1000).toFixed(1) + 's' : log.latency + 'ms'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500 max-w-[200px] truncate" title={log.error}>
                      {log.error || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {filteredLogs.length === 0 && (
            <div className="py-12 text-center text-slate-400">
              <ScrollText size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">暂无匹配的日志</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
