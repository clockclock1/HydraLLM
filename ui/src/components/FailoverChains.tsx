import { useState } from 'react';
import {
  Plus,
  Trash2,
  Edit3,
  X,
  GitBranch,
  ArrowUp,
  ArrowDown,
  Power,
  PowerOff,
  Copy,
  ChevronDown,
  ChevronUp,
  Shuffle,
  Layers,
  ArrowRight,
  Timer,
  RotateCcw,
  Weight,
  Gauge,
  Zap,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useStore } from '../store';
import type { FailoverChain, FailoverModel } from '../types';
import { cn } from '../utils/cn';

const strategyLabels: Record<FailoverChain['strategy'], { label: string; desc: string; icon: React.ReactNode }> = {
  'priority': { label: '优先级', desc: '按优先级顺序依次尝试', icon: <Layers size={14} /> },
  'round-robin': { label: '轮询', desc: '循环使用各模型', icon: <Shuffle size={14} /> },
  'weighted': { label: '加权', desc: '按权重比例分配请求', icon: <Weight size={14} /> },
  'latency-based': { label: '最低延迟', desc: '优先使用延迟最低的模型', icon: <Gauge size={14} /> },
};

function ChainEditor({
  chain,
  onSave,
  onClose,
}: {
  chain?: FailoverChain;
  onSave: (c: FailoverChain) => void;
  onClose: () => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState(chain?.name || '');
  const [description, setDescription] = useState(chain?.description || '');
  const [strategy, setStrategy] = useState<FailoverChain['strategy']>(chain?.strategy || 'priority');
  const [proxyModelName, setProxyModelName] = useState(chain?.proxyModelName || '');
  const [proxyApiKey, setProxyApiKey] = useState(chain?.proxyApiKey || 'fpk-' + uuidv4().slice(0, 24));
  const [models, setModels] = useState<FailoverModel[]>(chain?.models || []);

  const addModel = (providerId: string, modelName: string) => {
    if (models.find(m => m.providerId === providerId && m.modelName === modelName)) return;
    setModels([...models, {
      providerId,
      modelName,
      priority: models.length + 1,
      weight: Math.floor(100 / (models.length + 1)),
      maxRetries: 2,
      timeout: 30,
      enabled: true,
    }]);
  };

  const removeModel = (idx: number) => {
    setModels(models.filter((_, i) => i !== idx));
  };

  const moveModel = (idx: number, dir: -1 | 1) => {
    const next = [...models];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    next.forEach((m, i) => m.priority = i + 1);
    setModels(next);
  };

  const updateModel = (idx: number, updates: Partial<FailoverModel>) => {
    setModels(models.map((m, i) => i === idx ? { ...m, ...updates } : m));
  };

  const handleSave = () => {
    if (!name || !proxyModelName || models.length === 0) return;
    onSave({
      id: chain?.id || uuidv4(),
      name,
      description,
      strategy,
      proxyModelName,
      proxyApiKey,
      models,
      enabled: chain?.enabled ?? true,
      createdAt: chain?.createdAt || Date.now(),
      totalRequests: chain?.totalRequests || 0,
      failoverCount: chain?.failoverCount || 0,
      successRate: chain?.successRate || 100,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <h3 className="font-semibold text-slate-800">{chain ? '编辑故障转移链' : '创建故障转移链'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">链名称</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none text-sm transition-all"
                placeholder="GPT-4 高可用"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">代理模型名称</label>
              <input
                value={proxyModelName}
                onChange={e => setProxyModelName(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none text-sm font-mono transition-all"
                placeholder="my-gpt4-ha"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">描述</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none text-sm transition-all"
              placeholder="故障转移链的描述..."
            />
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">代理 API Key</label>
            <div className="flex gap-2">
              <input
                value={proxyApiKey}
                onChange={e => setProxyApiKey(e.target.value)}
                className="flex-1 px-4 py-2.5 rounded-lg border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none text-sm font-mono transition-all"
              />
              <button
                onClick={() => setProxyApiKey('fpk-' + uuidv4().slice(0, 24))}
                className="px-3 py-2.5 text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-sm"
              >
                重新生成
              </button>
            </div>
          </div>

          {/* Strategy */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">故障转移策略</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {(Object.keys(strategyLabels) as FailoverChain['strategy'][]).map(s => (
                <button
                  key={s}
                  onClick={() => setStrategy(s)}
                  className={cn(
                    'flex flex-col items-center gap-1 p-3 rounded-lg border text-sm transition-all',
                    strategy === s
                      ? 'border-blue-500 bg-blue-50 text-blue-700 ring-2 ring-blue-500/20'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                  )}
                >
                  {strategyLabels[s].icon}
                  <span className="font-medium text-xs">{strategyLabels[s].label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">{strategyLabels[strategy].desc}</p>
          </div>

          {/* Add Model */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">添加模型到转移链</label>
            <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50/50">
              {state.providers.map(provider => (
                <div key={provider.id}>
                  <p className="text-xs text-slate-500 mb-1 font-medium">{provider.name}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {provider.models.map(model => {
                      const isAdded = models.some(m => m.providerId === provider.id && m.modelName === model);
                      return (
                        <button
                          key={model}
                          onClick={() => addModel(provider.id, model)}
                          disabled={isAdded}
                          className={cn(
                            'text-xs px-2.5 py-1 rounded-md border transition-all',
                            isAdded
                              ? 'bg-blue-50 border-blue-200 text-blue-400 cursor-not-allowed'
                              : 'bg-white border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50'
                          )}
                        >
                          {isAdded ? '✓ ' : '+ '}{model}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Model Chain */}
          {models.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                转移链配置 ({models.length} 个模型)
              </label>
              <div className="space-y-2">
                {models.map((model, idx) => {
                  const provider = state.providers.find(p => p.id === model.providerId);
                  return (
                    <div key={idx} className={cn(
                      'border rounded-lg p-3 transition-all',
                      model.enabled ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-60'
                    )}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold',
                            idx === 0 ? 'bg-blue-100 text-blue-600' :
                            idx === 1 ? 'bg-amber-100 text-amber-600' :
                            'bg-slate-100 text-slate-500'
                          )}>
                            {idx + 1}
                          </span>
                          <div>
                            <span className="text-sm font-mono font-medium text-slate-700">{model.modelName}</span>
                            <span className="text-xs text-slate-400 ml-2">{provider?.name}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => moveModel(idx, -1)}
                            disabled={idx === 0}
                            className="p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30 transition-colors"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            onClick={() => moveModel(idx, 1)}
                            disabled={idx === models.length - 1}
                            className="p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30 transition-colors"
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            onClick={() => updateModel(idx, { enabled: !model.enabled })}
                            className={cn(
                              'p-1 transition-colors',
                              model.enabled ? 'text-emerald-500 hover:text-emerald-600' : 'text-slate-400 hover:text-slate-600'
                            )}
                          >
                            {model.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                          </button>
                          <button
                            onClick={() => removeModel(idx)}
                            className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      {/* Model settings */}
                      <div className="grid grid-cols-3 gap-3 mt-2">
                        <div>
                          <label className="text-[10px] text-slate-400 flex items-center gap-1 mb-0.5">
                            <Timer size={10} /> 超时(秒)
                          </label>
                          <input
                            type="number"
                            value={model.timeout}
                            onChange={e => updateModel(idx, { timeout: Number(e.target.value) })}
                            className="w-full px-2 py-1 text-xs rounded border border-slate-200 focus:border-blue-500 outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-400 flex items-center gap-1 mb-0.5">
                            <RotateCcw size={10} /> 最大重试
                          </label>
                          <input
                            type="number"
                            value={model.maxRetries}
                            onChange={e => updateModel(idx, { maxRetries: Number(e.target.value) })}
                            className="w-full px-2 py-1 text-xs rounded border border-slate-200 focus:border-blue-500 outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-400 flex items-center gap-1 mb-0.5">
                            <Weight size={10} /> 权重
                          </label>
                          <input
                            type="number"
                            value={model.weight}
                            onChange={e => updateModel(idx, { weight: Number(e.target.value) })}
                            className="w-full px-2 py-1 text-xs rounded border border-slate-200 focus:border-blue-500 outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 transition-colors">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={!name || !proxyModelName || models.length === 0}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FailoverChains() {
  const { state, dispatch } = useStore();
  const [showEditor, setShowEditor] = useState(false);
  const [editingChain, setEditingChain] = useState<FailoverChain | undefined>();
  const [expandedChain, setExpandedChain] = useState<string | null>(null);

  const handleSave = (c: FailoverChain) => {
    if (editingChain) {
      dispatch({ type: 'UPDATE_CHAIN', chain: c });
    } else {
      dispatch({ type: 'ADD_CHAIN', chain: c });
    }
    setShowEditor(false);
    setEditingChain(undefined);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">故障转移链</h2>
          <p className="text-slate-500 mt-1">配置模型故障转移策略和路由规则</p>
        </div>
        <button
          onClick={() => { setEditingChain(undefined); setShowEditor(true); }}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm shadow-sm shadow-blue-200"
        >
          <Plus size={16} />
          创建转移链
        </button>
      </div>

      {/* Chains */}
      <div className="space-y-4">
        {state.chains.map(chain => {
          const isExpanded = expandedChain === chain.id;
          return (
            <div key={chain.id} className={cn(
              'bg-white rounded-xl border overflow-hidden transition-all',
              chain.enabled ? 'border-slate-200' : 'border-slate-200 opacity-70'
            )}>
              {/* Header */}
              <div
                className="px-5 py-4 flex items-center justify-between cursor-pointer hover:bg-slate-50/50 transition-colors"
                onClick={() => setExpandedChain(isExpanded ? null : chain.id)}
              >
                <div className="flex items-center gap-4">
                  <div className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center',
                    chain.enabled ? 'bg-gradient-to-br from-blue-50 to-violet-50' : 'bg-slate-100'
                  )}>
                    <GitBranch size={20} className={chain.enabled ? 'text-blue-600' : 'text-slate-400'} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-slate-800">{chain.name}</h4>
                      <span className={cn(
                        'text-[10px] px-2 py-0.5 rounded-full font-medium',
                        chain.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'
                      )}>
                        {chain.enabled ? '已启用' : '已禁用'}
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-600">
                        {strategyLabels[chain.strategy].label}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{chain.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {/* Stats */}
                  <div className="hidden md:flex items-center gap-6 text-xs text-slate-500">
                    <div className="text-center">
                      <p className="font-semibold text-slate-700">{chain.totalRequests.toLocaleString()}</p>
                      <p>请求</p>
                    </div>
                    <div className="text-center">
                      <p className="font-semibold text-amber-600">{chain.failoverCount}</p>
                      <p>转移</p>
                    </div>
                    <div className="text-center">
                      <p className={cn('font-semibold', chain.successRate >= 99 ? 'text-emerald-600' : 'text-amber-600')}>
                        {chain.successRate}%
                      </p>
                      <p>成功率</p>
                    </div>
                  </div>

                  {/* Quick flow */}
                  <div className="hidden lg:flex items-center gap-1">
                    {chain.models.slice(0, 3).map((m, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <span className="text-[10px] font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                          {m.modelName.length > 12 ? m.modelName.slice(0, 12) + '…' : m.modelName}
                        </span>
                        {i < Math.min(chain.models.length, 3) - 1 && <ArrowRight size={10} className="text-slate-300" />}
                      </div>
                    ))}
                    {chain.models.length > 3 && (
                      <span className="text-[10px] text-slate-400">+{chain.models.length - 3}</span>
                    )}
                  </div>

                  {isExpanded ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
                </div>
              </div>

              {/* Expanded Detail */}
              {isExpanded && (
                <div className="border-t border-slate-100">
                  {/* Proxy Info */}
                  <div className="px-5 py-3 bg-gradient-to-r from-blue-50/50 to-violet-50/50 flex flex-wrap items-center gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">代理模型：</span>
                      <code className="bg-white px-2 py-0.5 rounded border border-slate-200 text-blue-600 font-mono text-xs">{chain.proxyModelName}</code>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">API Key：</span>
                      <code className="bg-white px-2 py-0.5 rounded border border-slate-200 text-slate-600 font-mono text-xs">{chain.proxyApiKey.slice(0, 12)}...</code>
                      <button
                        onClick={() => navigator.clipboard.writeText(chain.proxyApiKey)}
                        className="text-slate-400 hover:text-blue-600 transition-colors"
                        title="复制"
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Visual Flow Diagram */}
                  <div className="px-5 py-4">
                    <p className="text-xs font-medium text-slate-500 mb-3">故障转移流程</p>
                    <div className="flex items-center gap-2 overflow-x-auto pb-2">
                      {/* Request entry */}
                      <div className="flex-shrink-0 bg-gradient-to-br from-blue-500 to-blue-600 text-white px-3 py-2 rounded-lg text-xs font-medium shadow-sm">
                        <Zap size={12} className="inline mr-1" />
                        请求入口
                      </div>
                      <ArrowRight size={16} className="text-slate-300 flex-shrink-0" />

                      {chain.models.map((m, i) => {
                        const provider = state.providers.find(p => p.id === m.providerId);
                        const isOnline = provider?.status === 'online';
                        return (
                          <div key={i} className="flex items-center gap-2 flex-shrink-0">
                            <div className={cn(
                              'border rounded-lg p-2.5 min-w-[120px] transition-all',
                              !m.enabled ? 'bg-slate-50 border-slate-200 border-dashed' :
                              isOnline ? 'bg-white border-slate-200 shadow-sm' :
                              'bg-red-50 border-red-200'
                            )}>
                              <div className="flex items-center gap-1.5 mb-1">
                                <div className={cn(
                                  'w-2 h-2 rounded-full',
                                  !m.enabled ? 'bg-slate-300' : isOnline ? 'bg-emerald-500' : 'bg-red-500'
                                )} />
                                <span className="text-[10px] text-slate-400">{provider?.name}</span>
                              </div>
                              <p className="text-xs font-mono font-medium text-slate-700 truncate">{m.modelName}</p>
                              <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-400">
                                <span>W:{m.weight}</span>
                                <span>T:{m.timeout}s</span>
                                <span>R:{m.maxRetries}</span>
                              </div>
                              <button
                                onClick={() => {
                                  const nextModels = chain.models
                                    .filter((_, modelIndex) => modelIndex !== i)
                                    .map((item, modelIndex) => ({ ...item, priority: modelIndex + 1 }));
                                  dispatch({ type: 'UPDATE_CHAIN', chain: { ...chain, models: nextModels } });
                                }}
                                className="mt-2 flex items-center gap-1 text-[10px] text-red-500 hover:text-red-600"
                                title="删除该模型"
                              >
                                <Trash2 size={10} />
                                删除
                              </button>
                            </div>
                            {i < chain.models.length - 1 && (
                              <div className="flex flex-col items-center flex-shrink-0">
                                <span className="text-[9px] text-red-400 mb-0.5">失败</span>
                                <ArrowRight size={14} className="text-red-300" />
                              </div>
                            )}
                          </div>
                        );
                      })}

                      <ArrowRight size={16} className="text-slate-300 flex-shrink-0" />
                      <div className="flex-shrink-0 bg-gradient-to-br from-emerald-500 to-emerald-600 text-white px-3 py-2 rounded-lg text-xs font-medium shadow-sm">
                        ✓ 响应
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          dispatch({ type: 'UPDATE_CHAIN', chain: { ...chain, enabled: !chain.enabled } });
                        }}
                        className={cn(
                          'text-xs px-3 py-1.5 rounded-lg border transition-colors',
                          chain.enabled
                            ? 'border-amber-200 text-amber-600 hover:bg-amber-50'
                            : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'
                        )}
                      >
                        {chain.enabled ? '禁用' : '启用'}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setEditingChain(chain); setShowEditor(true); }}
                        className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                      >
                        <Edit3 size={12} /> 编辑
                      </button>
                      <button
                        onClick={() => dispatch({ type: 'DELETE_CHAIN', id: chain.id })}
                        className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 size={12} /> 删除
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {state.chains.length === 0 && (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
          <GitBranch size={40} className="mx-auto text-slate-300 mb-3" />
          <p className="text-slate-500">暂无故障转移链</p>
          <p className="text-xs text-slate-400 mt-1">创建第一条故障转移链来开始使用</p>
        </div>
      )}

      {showEditor && (
        <ChainEditor
          chain={editingChain}
          onSave={handleSave}
          onClose={() => { setShowEditor(false); setEditingChain(undefined); }}
        />
      )}
    </div>
  );
}
