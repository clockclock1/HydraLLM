import { RefreshCw, RotateCcw, Save, ShieldAlert, SlidersHorizontal, Timer } from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../utils/cn';

export default function Settings() {
  const { state, dispatch, saveConfig, loadConfig } = useStore();
  const busy = state.saveStatus === 'loading' || state.saveStatus === 'saving';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">队列设置</h2>
          <p className="text-slate-500 mt-1">统一配置故障转移请求和熔断行为</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadConfig().catch(() => undefined)}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={15} className={state.saveStatus === 'loading' ? 'animate-spin' : ''} />
            加载
          </button>
          <button
            type="button"
            onClick={() => saveConfig().catch(() => undefined)}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm shadow-blue-200 transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save size={15} />
            保存
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <SlidersHorizontal size={18} />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">请求队列</h3>
              <p className="text-xs text-slate-400">应用到所有故障转移目标</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-500">
                <Timer size={12} /> 超时(秒)
              </span>
              <input
                type="number"
                min={1}
                value={state.targetTimeoutSeconds}
                onChange={event => dispatch({
                  type: 'SET_TARGET_SETTINGS',
                  timeoutSeconds: Number(event.target.value),
                  maxRetries: state.targetMaxRetries,
                })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-500">
                <RotateCcw size={12} /> 最大重试
              </span>
              <input
                type="number"
                min={0}
                value={state.targetMaxRetries}
                onChange={event => dispatch({
                  type: 'SET_TARGET_SETTINGS',
                  timeoutSeconds: state.targetTimeoutSeconds,
                  maxRetries: Number(event.target.value),
                })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
              <ShieldAlert size={18} />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">熔断保护</h3>
              <p className="text-xs text-slate-400">避免持续命中不可用上游</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">连续失败次数</span>
              <input
                type="number"
                min={1}
                value={state.circuitFailureThreshold}
                onChange={event => dispatch({
                  type: 'SET_CIRCUIT_SETTINGS',
                  failureThreshold: Number(event.target.value),
                  cooldownMinutes: state.circuitCooldownMinutes,
                })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">禁用分钟数</span>
              <input
                type="number"
                min={1}
                value={state.circuitCooldownMinutes}
                onChange={event => dispatch({
                  type: 'SET_CIRCUIT_SETTINGS',
                  failureThreshold: state.circuitFailureThreshold,
                  cooldownMinutes: Number(event.target.value),
                })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
          </div>
        </section>
      </div>

      <p className={cn(
        'min-h-5 text-xs',
        state.saveStatus === 'error' ? 'text-red-500' :
        state.saveStatus === 'saved' ? 'text-emerald-600' : 'text-slate-400'
      )}>
        {state.saveStatus === 'loading' && '正在加载配置...'}
        {state.saveStatus === 'saving' && '正在保存配置...'}
        {state.saveStatus === 'saved' && '配置已保存'}
        {state.saveStatus === 'error' && (state.saveError || '操作失败')}
        {state.saveStatus === 'idle' && (state.configLoaded ? '已连接后端配置' : '等待加载配置')}
      </p>
    </div>
  );
}
