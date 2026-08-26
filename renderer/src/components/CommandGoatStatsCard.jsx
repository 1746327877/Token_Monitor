// Command Goat 使用卡片:本月 Token / 费用 / 运行次数(来自 Studio 概览页)。
import React, { useEffect, useState } from 'react';
import { getCommandGoatStats, onProvidersChanged } from '../api.js';

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
  return value.toString();
}

export default function CommandGoatStatsCard() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    getCommandGoatStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    return onProvidersChanged(() => {
      getCommandGoatStats().then(setStats).catch(() => {});
    });
  }, []);

  if (!stats) {
    return (
      <div className="fee-card-content">
        <div className="fee-card-value-wrap"><div className="fee-card-value primary">--</div></div>
        <div className="fee-card-sub">等待 Command Goat 数据…</div>
      </div>
    );
  }

  return (
    <div className="fee-card-content">
      <div className="fee-card-value-wrap">
        <div key={String(stats.tokens)} className="fee-card-value primary ef-flash-value">{formatTokens(stats.tokens)}</div>
      </div>
      <div className="fee-card-sub">
        本月 Token<br />
        费用 ${(Number(stats.cost) || 0).toFixed(2)} · {stats.runs || 0} 次运行
      </div>
    </div>
  );
}
