// 订阅制额度卡片:由 windows 数组驱动(不写死两条);subscription 模式不显示任何金额;
// authStatus==='expired' 时替换为重新授权按钮。
// 套餐徽标:prolite→5x Pro / pro→20x Pro / plus→Plus 套餐;未检测到(API 用户)不显示。
// Command Goat 支持双号:provider.quota 可能是 { accounts:[{slot,name,quota}] },卡片头部提供
// 下拉切换"全部 / 号1 / 号2",多号同时显示时每个号独立分块并标注号名。
import React, { useEffect, useState } from 'react';
import WindowBar from './WindowBar.jsx';

function planBadgeLabel(planName) {
  const p = (planName || '').trim().toLowerCase();
  if (!p) return null;
  if (p === 'prolite') return '5x Pro';
  if (p === 'pro') return '20x Pro';
  if (p === 'plus') return 'Plus 套餐';
  return planName;
}

// Kimi 套餐名是音乐术语(andante/moderato/allegretto/allegro),首字母大写原样展示
function kimiPlanLabel(planName) {
  const p = (planName || '').trim();
  if (!p) return null;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// 解析 quotaState:兼容旧单号形态与新的 { accounts: [...] } 多号形态。
function normalizeAccounts(quotaState, providerId) {
  if (quotaState && Array.isArray(quotaState.accounts)) {
    return quotaState.accounts.filter((a) => a && (a.quota || a.error));
  }
  if (quotaState && quotaState.windows) {
    return [{ slot: '1', name: '号1', quota: quotaState }];
  }
  if (quotaState) {
    return [{ slot: '1', name: '号1', quota: quotaState }];
  }
  return [];
}

function QuotaGroup({ quota, title }) {
  if (!quota) return null;
  const windows = quota.windows || [];
  const badge = quota.planName && quota.planName !== title ? planBadgeLabel(quota.planName) : null;
  return (
    <div className="quota-group">
      <div className="quota-group-head">
        <span className="quota-group-name">{title}</span>
        {badge ? <span className="quota-card-plan-badge">{badge}</span> : null}
      </div>
      {windows.map((w) => (
        <WindowBar key={(w.name || '') + w.kind + title} kind={w.kind} name={w.name} used={w.used} limit={w.limit} remaining={w.remaining} resetsAt={w.resetsAt} />
      ))}
      {quota.billingMode === 'subscription' && quota.billingCycleEnd ? (
        <div className="quota-card-cycle">订阅续费日:{quota.billingCycleEnd}</div>
      ) : null}
    </div>
  );
}

export default function QuotaCard({ provider, quotaState, authStatus, onReauthorize }) {
  const [view, setView] = useState('all');
  const isGoat = !!(provider && provider.id === 'command-goat');
  const accounts = normalizeAccounts(quotaState, provider && provider.id);
  const totalSlots = isGoat ? 2 : 1;

  // 号登录/退出变化时,若当前视图指向的号已不存在则回退到 all
  useEffect(() => {
    if (view !== 'all') {
      const exists = accounts.some((a) => a.slot === view);
      if (!exists) setView('all');
    }
  }, [accounts, view]);

  if (authStatus === 'expired') {
    return (
      <div className="quota-card quota-expired">
        <div className="quota-card-head">
          <span className="quota-card-plan">{provider ? provider.displayName : ''} 登录已过期</span>
        </div>
        <button className="quota-reauth-btn" onClick={onReauthorize}>点击重新授权</button>
        <div className="quota-reauth-hint">请先在终端运行一次 {provider ? provider.id : ''} 登录命令</div>
      </div>
    );
  }

  const title = (provider && provider.displayName) || (quotaState && quotaState.planName) || '';

  // 无额度数据
  if (!accounts.length) {
    return (
      <div className="quota-card quota-empty">
        <div className="quota-card-head"><span className="quota-card-plan">{title}</span></div>
        <div className="quota-empty-text">暂无额度数据</div>
      </div>
    );
  }

  const isKimi = !!(provider && provider.id === 'kimi');
  const kimiPlan = isKimi ? kimiPlanLabel(quotaState && quotaState.planName) : null;

  // 选中视图
  let shown = accounts;
  if (view !== 'all') {
    shown = accounts.filter((a) => a.slot === view);
  }

  return (
    <div className="quota-card">
      <div className="quota-card-head">
        <span className="quota-card-plan">{title}</span>
        {kimiPlan ? <span className="quota-card-plan-kimi">{kimiPlan}</span> : null}
        {isGoat && totalSlots > 1 ? (
          <div className="quota-view-select" onClick={(e) => e.stopPropagation()}>
            <select
              className="quota-view-select-input"
              value={view}
              onChange={(e) => setView(e.target.value)}
              title="切换显示的账号额度"
            >
              <option value="all">全部</option>
              {accounts.map((a) => (
                <option key={a.slot} value={a.slot}>{a.name}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {shown.map((a) => (
        <div key={a.slot}>
          {isGoat && shown.length > 1 ? (
            <div className="quota-group-title">{a.name}</div>
          ) : null}
          {a.quota ? (
            <QuotaGroup quota={a.quota} title={a.name || title} />
          ) : (
            <div className="quota-empty-text">暂无数据</div>
          )}
        </div>
      ))}
    </div>
  );
}
