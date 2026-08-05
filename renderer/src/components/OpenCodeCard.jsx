// OpenCode 使用卡片:今日/累计 token 与费用 + 今日按模型分布。
// 数据来自主进程 get:opencode-stats(基于本地会话消息聚合,不经过任何平台 API)。
import React, { useEffect, useState } from 'react';
import { getOpenCodeStats, onProvidersChanged } from '../api.js';

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
  return value.toString();
}

function formatCost(n) {
  return '$' + (Number(n) || 0).toFixed(4);
}

export default function OpenCodeCard() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    getOpenCodeStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    return onProvidersChanged(() => {
      getOpenCodeStats().then(setStats).catch(() => {});
    });
  }, []);

  if (!stats) {
    return (
      <div className="fee-card-content">
        <div className="fee-card-value-wrap"><div className="fee-card-value primary">--</div></div>
        <div className="fee-card-sub">等待 OpenCode 数据…</div>
      </div>
    );
  }

  const today = stats.today || {};
  const total = stats.total || {};
  const models = today.models || [];

  return (
    <div className="fee-card-content">
      <div className="fee-card-value-wrap">
        <div className="fee-card-value primary">{formatTokens(today.tokens)}</div>
      </div>
      <div className="fee-card-sub">
        今日 {formatCost(today.cost)} · {today.messages || 0} 条<br />
        累计 {formatTokens(total.tokens)} · {formatCost(total.cost)}
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
