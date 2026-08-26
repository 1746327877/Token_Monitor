// 标题栏:刷新/设置/布局编辑/置顶图钉/最小化/关闭按钮,图标沿用旧 SVG。
// 关闭按钮行为与旧版一致(隐藏到托盘 = window:minimize)。
// 刷新/设置点击有短暂图标动画;布局编辑按钮切换激活外观表示"编排中"。
// 点击任意按钮触发 ef-sweep 工业渐变扫过视效。
import React, { useState, useEffect } from 'react';
import { send, getSettings, on } from '../api.js';

export default function TitleBar({ editing, onToggleLayoutEdit }) {
  const [spinning, setSpinning] = useState(false);
  const [gearTap, setGearTap] = useState(false);
  const [sweep, setSweep] = useState('');
  const [onTop, setOnTop] = useState(true);

  // 置顶状态:初始读取设置,之后跟随设置广播(含图钉切换与设置窗口开关)
  useEffect(() => {
    getSettings().then((s) => setOnTop(!!(s && s.window && s.window.alwaysOnTop))).catch(() => {});
    return on('settings:loaded', (s) => setOnTop(!!(s && s.window && s.window.alwaysOnTop)));
  }, []);

  const onRefresh = () => {
    send('refresh:dashboard');
    setSpinning(true);
  };
  const onSettings = () => {
    send('open:settings');
    setGearTap(true);
  };
  const triggerSweep = (id) => {
    setSweep(id);
  };

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-logo" aria-hidden="true">
          <svg viewBox="0 0 108 120" width="100%" height="100%">
            <rect x="0" y="0" width="32" height="32" rx="4" fill="#fffa00" />
            <rect x="38" y="0" width="32" height="32" rx="4" fill="#00ffa2" />
            <rect x="76" y="0" width="32" height="32" rx="4" fill="#ff1aac" />
            <rect x="38" y="38" width="32" height="38" rx="4" fill="#fffa00" />
            <rect x="38" y="82" width="32" height="38" rx="4" fill="#00ffa2" />
          </svg>
        </span>
        <span className="titlebar-text">Token Monitor</span>
      </div>
      <div className="titlebar-actions">
        <button
          className={'titlebar-btn' + (spinning ? ' spin-refresh' : '') + (sweep === 'refresh' ? ' ef-sweep' : '')}
          title="立即刷新"
          onClick={() => { onRefresh(); triggerSweep('refresh'); }}
          onAnimationEnd={() => { setSpinning(false); if (sweep === 'refresh') setSweep(''); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
        <button
          className={'titlebar-btn titlebar-btn-layout' + (editing ? ' active' : '') + (sweep === 'layout' ? ' ef-sweep' : '')}
          title={editing ? '完成布局编排' : '编辑布局'}
          aria-label="编辑布局"
          aria-pressed={editing ? 'true' : 'false'}
          onClick={() => { onToggleLayoutEdit(); triggerSweep('layout'); }}
          onAnimationEnd={() => { if (sweep === 'layout') setSweep(''); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="14" width="8" height="6" rx="1.5" /><rect x="13" y="14" width="8" height="6" rx="1.5" /></svg>
        </button>
        <button
          className={'titlebar-btn titlebar-btn-pin' + (onTop ? ' active' : '') + (sweep === 'pin' ? ' ef-sweep' : '')}
          title={onTop ? '取消置顶' : '窗口置顶'}
          aria-label="窗口置顶"
          aria-pressed={onTop ? 'true' : 'false'}
          onClick={() => { send('window:toggle-always-on-top'); triggerSweep('pin'); }}
          onAnimationEnd={() => { if (sweep === 'pin') setSweep(''); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={onTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" /></svg>
        </button>
        <button
          className={'titlebar-btn' + (gearTap ? ' spin-gear' : '') + (sweep === 'settings' ? ' ef-sweep' : '')}
          title="设置"
          onClick={() => { onSettings(); triggerSweep('settings'); }}
          onAnimationEnd={() => { setGearTap(false); if (sweep === 'settings') setSweep(''); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        </button>
        <button
          className={'titlebar-btn' + (sweep === 'min' ? ' ef-sweep' : '')}
          title="最小化"
          onClick={() => { send('window:minimize'); triggerSweep('min'); }}
          onAnimationEnd={() => { if (sweep === 'min') setSweep(''); }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8.5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8.5z" /></svg>
        </button>
        <button
          className={'titlebar-btn' + (sweep === 'close' ? ' ef-sweep' : '')}
          title="关闭"
          onClick={() => { send('window:minimize'); triggerSweep('close'); }}
          onAnimationEnd={() => { if (sweep === 'close') setSweep(''); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>
  );
}
