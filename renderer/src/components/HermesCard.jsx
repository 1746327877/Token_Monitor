// Hermes 使用卡片:今日/累计 token 与消息数 + 今日按模型分布。
// 数据来自主进程 get:hermes-stats(读 hermes state.db 的 session_model_usage,行级增量)。
import React, { useEffect, useState } from 'react';
import { getHermesStats, onProvidersChanged } from '../api.js';

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
  return value.toString();
}

function formatCost(n) {
  const c = Number(n) || 0;
  return c > 0 ? '$' + c.toFixed(2) : '';
}

export default function HermesCard() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    getHermesStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    return onProvidersChanged(() => {
      getHermesStats().then(setStats).catch(() => {});
    });
  }, []);

  if (!stats) {
    return (
      <div className="fee-card-content">
        <div className="fee-card-value-wrap"><div className="fee-card-value primary">--</div></div>
        <div className="fee-card-sub">等待 Hermes 数据…</div>
      </div>
    );
  }

  const today = stats.today || {};
  const total = stats.total || {};
  const models = today.models || [];

  return (
    <div className="fee-card-content">
      <div className="fee-card-value-wrap">
        <div key={String(today.tokens)} className="fee-card-value primary ef-flash-value">{formatTokens(today.tokens)}</div>
      </div>
      <div className="fee-card-sub">
        今日 {today.messages || 0} 条{formatCost(today.cost) ? ' · ' + formatCost(today.cost) : ''}<br />
        累计 {formatTokens(total.tokens)} · {total.days || 0} 天
      </div>
      {models.length ? (
        <div className="opencode-model-list">
          {models.slice(0, 3).map((m) => (
            <div key={m.model} className="opencode-model-row">
              <span className="opencode-model-name">{m.model}</span>
              <span className="opencode-model-value">{formatTokens(m.tokens)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
