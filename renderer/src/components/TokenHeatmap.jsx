// GitHub 风格 Token 活动热力图:每日(53×7)/每周(53 列 1 行)/累计(高度条)三模式。
// 颜色用主题 primary(#fffa00)的 5 档透明度;hover tooltip 显示日期与用量。
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getHeatmap, onProvidersChanged } from '../api.js';
import { buildWeeks, colorLevel, formatToken, isoWeekKey } from '../lib/heatmap.js';

const CELL = 12;
const GAP = 2;
const LEVEL_ALPHA = [0.06, 0.18, 0.38, 0.62, 0.9];
const PROVIDER_OPTS = [
  { id: 'all', label: '全部' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'codex', label: 'Codex' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'command-goat', label: 'Command Goat' }
];

function dateLabel(date) {
  const d = new Date(date + 'T00:00:00');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

export default function TokenHeatmap({ provider = 'all', year = new Date().getFullYear() }) {
  const [selProvider, setSelProvider] = useState(provider);
  const [mode, setMode] = useState('daily');
  const [data, setData] = useState({ days: {}, maxDaily: 0 });
  const [boxWidth, setBoxWidth] = useState(0);
  const [tip, setTip] = useState(null);
  const rootRef = useRef(null);
  const tipRef = useRef(null);
  const tipTimers = useRef({ settle: null, hide: null, fade: null });
  const pendingTip = useRef(null);
  const lastTipX = useRef(0);

  useEffect(() => {
    getHeatmap({ provider: selProvider, year: year }).then(setData).catch(() => {});
  }, [selProvider, year]);

  // 手动刷新/定时轮询成功后重取,保持与状态栏"刷新时间"同步
  useEffect(() => {
    return onProvidersChanged(() => {
      getHeatmap({ provider: selProvider, year: year }).then(setData).catch(() => {});
    });
  }, [selProvider, year]);

  // 以容器宽度为准(grid 内板块可被拖窄),而不是窗口宽度
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setBoxWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const weeks = useMemo(() => buildWeeks(year), [year]);
  const days = data.days || {};
  const maxDaily = data.maxDaily || 0;

  // 自适应容器宽度:只保留最近若干周(结尾对齐本周);宽度足够时显示全年
  const colWidth = mode === 'weekly' ? CELL + GAP + 6 : CELL + GAP;
  const availWidth = boxWidth > 0 ? boxWidth - 4 : window.innerWidth - 52;
  const maxCols = Math.max(4, Math.floor(availWidth / colWidth));
  const todayCol = useMemo(() => {
    const now = new Date();
    const iso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    for (let c = 0; c < weeks.length; c++) {
      if (weeks[c].some((cell) => cell && cell.date === iso)) return c;
    }
    return weeks.length - 1;
  }, [weeks]);
  const end = maxCols >= weeks.length ? weeks.length : Math.min(weeks.length, todayCol + 1);
  const start = maxCols >= weeks.length ? 0 : Math.max(0, end - maxCols);
  const visibleWeeks = useMemo(() => weeks.slice(start, end), [weeks, start, end]);

  // 月份标签:每月 1 日所在列显示 'M月'
  const monthLabels = useMemo(() => {
    const startMs = new Date(weeks[0][0].date + 'T00:00:00').getTime();
    const labels = {};
    for (let m = 0; m < 12; m++) {
      const first = new Date(year, m, 1);
      if (first.getFullYear() !== year) continue;
      const col = Math.floor((first.getTime() - startMs) / 86400000 / 7);
      if (col >= 0 && col < weeks.length) labels[col] = (m + 1) + '月';
    }
    return labels;
  }, [weeks, year]);

  // 每周模式:按 ISO 周求和
  const weekTotals = useMemo(() => {
    const totals = {};
    Object.keys(days).forEach((date) => {
      const total = Number(days[date]) || 0;
      if (total <= 0) return;
      const key = isoWeekKey(new Date(date + 'T00:00:00'));
      totals[key] = (totals[key] || 0) + total;
    });
    return totals;
  }, [days]);
  const maxWeek = Math.max(0, ...Object.values(weekTotals));

  // 每周模式:分平台的周合计(tooltip 明细用)
  const weekByProvider = useMemo(() => {
    const det = data.details || {};
    const out = {};
    Object.keys(det.byProvider || {}).forEach((pid) => {
      Object.keys(det.byProvider[pid] || {}).forEach((date) => {
        const t = Number(det.byProvider[pid][date]) || 0;
        if (t <= 0) return;
        const key = isoWeekKey(new Date(date + 'T00:00:00'));
        out[pid] = out[pid] || {};
        out[pid][key] = (out[pid][key] || 0) + t;
      });
    });
    return out;
  }, [data]);

  // 按月模式:每月总 token(当月全部日值求和)
  const monthTotals = useMemo(() => {
    const out = {};
    Object.keys(days).forEach((date) => {
      if (!date.startsWith(year + '-')) return;
      const mKey = date.slice(0, 7);
      out[mKey] = (out[mKey] || 0) + (Number(days[date]) || 0);
    });
    return out;
  }, [days, year]);
  const maxMonth = Math.max(0, ...Object.values(monthTotals));

  // 按月模式:分平台的月度合计(tooltip 明细用)
  const monthByProvider = useMemo(() => {
    const det = data.details || {};
    const out = {};
    Object.keys(det.byProvider || {}).forEach((pid) => {
      Object.keys(det.byProvider[pid] || {}).forEach((date) => {
        if (!date.startsWith(year + '-')) return;
        const t = Number(det.byProvider[pid][date]) || 0;
        if (t <= 0) return;
        const mKey = date.slice(0, 7);
        out[mKey] = out[mKey] || {};
        out[mKey][pid] = (out[mKey][pid] || 0) + t;
      });
    });
    return out;
  }, [data, year]);

  // 取某列用于每周/累计的日期(该列最后一个 inYear 格)
  function lastInYearDate(col) {
    for (let r = 6; r >= 0; r--) {
      const cell = weeks[col][r];
      if (cell && cell.inYear) return cell.date;
    }
    return null;
  }

  // 每周/累计柱的悬停日期:该列内最后一个"有数据"的日期。
  // 当前列的最后 inYear 日期可能是未来(本周未过完),查累计表会落空。
  function columnTipDate(col) {
    const cells = weeks[col] || [];
    for (let r = cells.length - 1; r >= 0; r--) {
      const cell = cells[r];
      if (cell && cell.inYear && days[cell.date] !== undefined) return cell.date;
    }
    return lastInYearDate(col);
  }

  // 自定义悬停提示(原生 title 在透明窗口不显示;内容:日期 + 平台/模型明细)
  // 初始位置用估计半宽钳制,渲染后由 useLayoutEffect 按实测宽度二次校正(向窗口中间靠拢)
  const clampTipX = (x) => Math.max(104, Math.min(window.innerWidth - 104, x));
  // GitHub 贡献图式悬停意图:鼠标在格子上停稳 SHOW_DELAY 后才加载浮层;
  // 快速划过时定时器不断被取消,浮层不会出现,信息不闪烁。
  const SHOW_DELAY = 220;
  const HIDE_DELAY = 120;
  const FADE_OUT = 320;
  const clearTimer = (k) => {
    if (tipTimers.current[k]) {
      clearTimeout(tipTimers.current[k]);
      tipTimers.current[k] = null;
    }
  };
  const cancelTipHide = () => ['hide', 'fade'].forEach(clearTimer);
  const showTip = (e, date, overrideLines) => {
    if (!date) return;
    ['settle', 'hide', 'fade'].forEach(clearTimer);
    lastTipX.current = e.clientX;
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 140;
    pendingTip.current = {
      x: clampTipX(r.left + r.width / 2),
      y: below ? r.bottom + 6 : r.top - 6,
      below: below,
      date: date,
      overrideLines: overrideLines || null
    };
    // 换格子时旧浮层立即开始淡出(内容不原地替换),新内容停稳后才淡入
    setTip((prev) => (prev && !prev.fading ? Object.assign({}, prev, { fading: true }) : prev));
    tipTimers.current.settle = setTimeout(() => {
      tipTimers.current.settle = null;
      if (!pendingTip.current) return;
      setTip(Object.assign({}, pendingTip.current, { x: clampTipX(lastTipX.current) }));
    }, SHOW_DELAY);
  };
  // 格子内跟随鼠标横移,配合 CSS transition 在格子间平滑滑动
  const moveTip = (e) => {
    lastTipX.current = e.clientX;
    setTip((prev) => (prev && !prev.fading ? Object.assign({}, prev, { x: clampTipX(e.clientX) }) : prev));
  };
  const hideTip = () => {
    pendingTip.current = null;
    clearTimer('settle');
    cancelTipHide();
    tipTimers.current.hide = setTimeout(() => {
      tipTimers.current.hide = null;
      setTip((prev) => (prev ? Object.assign({}, prev, { fading: true }) : prev));
      tipTimers.current.fade = setTimeout(() => {
        tipTimers.current.fade = null;
        setTip(null);
      }, FADE_OUT);
    }, HIDE_DELAY);
  };

  // 实测浮层宽度:内容(缓存明细)会把浮层撑到 260px+,估计值钳不紧,
  // 这里按 offsetWidth 把中心点夹回窗口内,与 echarts confine 行为一致
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const half = el.offsetWidth / 2 + 8;
    const x = Math.max(half, Math.min(window.innerWidth - half, tip.x));
    if (Math.abs(x - tip.x) > 0.5) el.style.left = x + 'px';
  }, [tip]);

  function tipLines(date) {
    const det = data.details || {};
    const byProvider = det.byProvider || {};
    const cachedByProvider = det.cachedByProvider || {};
    const total = Number(days[date]) || 0;
    const lines = [];
    const cachedSuffix = (pid) => {
      const c = cachedByProvider[pid] && Number(cachedByProvider[pid][date]);
      return c > 0 ? '（缓存 ' + formatToken(c) + '）' : '';
    };
    // 当前视图下的平台清单(选中单个平台时只列它)
    const pids = (selProvider === 'all'
      ? PROVIDER_OPTS.filter((p) => p.id !== 'all').map((p) => p.id)
      : [selProvider]);

    // 每周模式:该周的各平台合计(而非最后一天的日值)
    if (mode === 'weekly') {
      const key = isoWeekKey(new Date(date + 'T00:00:00'));
      pids.forEach((pid) => {
        const wk = weekByProvider[pid] && Number(weekByProvider[pid][key]);
        if (wk > 0) {
          const p = PROVIDER_OPTS.find((o) => o.id === pid);
          lines.push({ label: p ? p.label : pid, value: formatToken(wk) + ' Token' });
        }
      });
      return lines;
    }

    // 按月模式:该月的各平台合计
    if (mode === 'cumulative') {
      const cums = monthByProvider[date] || {};
      pids.forEach((pid) => {
        const v = Number(cums[pid]) || 0;
        if (v > 0) {
          const p = PROVIDER_OPTS.find((o) => o.id === pid);
          lines.push({ label: p ? p.label : pid, value: formatToken(v) + ' Token' });
        }
      });
      return lines;
    }

    // 每日模式:当日各平台明细
    if (selProvider === 'all') {
      pids.forEach((pid) => {
        const t = byProvider[pid] && Number(byProvider[pid][date]);
        if (t > 0) {
          const p = PROVIDER_OPTS.find((o) => o.id === pid);
          lines.push({ label: p ? p.label : pid, value: formatToken(t) + ' Token' + cachedSuffix(pid) });
        }
      });
    } else if (selProvider === 'deepseek') {
      if (total > 0) lines.push({ label: 'DeepSeek 合计', value: formatToken(total) + ' Token' + cachedSuffix('deepseek') });
      ((det.deepseekModels || {})[date] || []).forEach((m) => {
        if (m.tokens > 0) lines.push({ label: m.model, value: formatToken(m.tokens) + ' Token' });
      });
    } else {
      const p = PROVIDER_OPTS.find((o) => o.id === selProvider);
      if (total > 0) lines.push({ label: p ? p.label : selProvider, value: formatToken(total) + ' Token' + cachedSuffix(selProvider) });
    }
    return lines;
  }

  function renderDaily() {
    return (
      <div className="heatmap-grid heatmap-grid-daily">
        {visibleWeeks.map((col, i) => (
          <div className="heatmap-col" key={start + i}>
            {col.map((cell, r) => {
              const total = cell && days[cell.date] ? Number(days[cell.date]) : 0;
              const level = colorLevel(total, maxDaily);
              const style = {
                width: CELL,
                height: CELL,
                background: cell && cell.inYear
                  ? 'rgba(255,250,0,' + LEVEL_ALPHA[level] + ')'
                  : 'rgba(255,255,255,0.05)'
              };
              return cell ? (
                <div
                  key={r}
                  className="heatmap-cell"
                  style={style}
                  onMouseEnter={(e) => showTip(e, cell.date)}
                  onMouseMove={moveTip} onMouseLeave={hideTip}
                />
              ) : <div key={r} style={{ width: CELL, height: CELL }} />;
            })}
          </div>
        ))}
      </div>
    );
  }

  function renderWeekly() {
    return (
      <div className="heatmap-grid heatmap-grid-weekly">
        {visibleWeeks.map((col, i) => {
          const c = start + i;
          const date = columnTipDate(c);
          const total = date && weekTotals[isoWeekKey(new Date(date + 'T00:00:00'))] ? weekTotals[isoWeekKey(new Date(date + 'T00:00:00'))] : 0;
          const level = colorLevel(total, maxWeek);
          return (
            <div
              key={c}
              className="heatmap-cell"
              style={{
                width: CELL + 6,
                height: CELL + 6,
                background: 'rgba(255,250,0,' + LEVEL_ALPHA[level] + ')'
              }}
              onMouseEnter={(e) => showTip(e, date)}
              onMouseMove={moveTip} onMouseLeave={hideTip}
            />
          );
        })}
      </div>
    );
  }

  function renderMonthly() {
    const keys = Object.keys(monthTotals).sort();
    return (
      <div className="heatmap-grid heatmap-grid-monthly">
        {keys.map((mKey) => {
          const total = monthTotals[mKey];
          const height = maxMonth > 0 ? Math.max(8, Math.round((total / maxMonth) * 120)) : 8;
          return (
            <div key={mKey} className="heatmap-month-bar-col">
              <span className="heatmap-month-bar-value">{formatToken(total)}</span>
              <div
                className="heatmap-month-bar"
                style={{ height: height }}
                onMouseEnter={(e) => showTip(e, mKey)}
                onMouseMove={moveTip} onMouseLeave={hideTip}
              />
              <span className="heatmap-month-bar-label">{parseInt(mKey.slice(5), 10) + '月'}</span>
            </div>
          );
        })}
      </div>
    );
  }

  const monthRow = (
    <div className="heatmap-months">
      {visibleWeeks.map((col, i) => {
        const c = start + i;
        const label = monthLabels[c];
        return (
          <div key={c} className="heatmap-month-cell" style={{ width: CELL + (mode === 'daily' ? GAP : GAP + 6) }}>
            {label ? <span className={'heatmap-month-text' + (i === visibleWeeks.length - 1 ? ' last' : '')}>{label}</span> : ''}
          </div>
        );
      })}
    </div>
  );

  // 浮层头部右侧的总量:每日=当日合计;每周=该 ISO 周合计;按月=当月合计
  function tipTotal(key) {
    if (mode === 'weekly') return weekTotals[isoWeekKey(new Date(key + 'T00:00:00'))] || 0;
    if (mode === 'cumulative') return monthTotals[key] || 0;
    return Number(days[key]) || 0;
  }

  // tooltip 头部标签:按月模式传的是 'YYYY-MM' 月键
  function tipLabel(key) {
    if (/^\d{4}-\d{2}$/.test(String(key))) return parseInt(key.slice(5), 10) + '月';
    return dateLabel(key);
  }

  return (
    <div className="heatmap-widget" ref={rootRef}>
      <div className="heatmap-head">
        <span className="heatmap-title">Token 活动</span>
        <div className="heatmap-providers">
          {PROVIDER_OPTS.map((p) => (
            <button
              key={p.id}
              className={'heatmap-tab' + (selProvider === p.id ? ' active' : '')}
              onClick={() => setSelProvider(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="heatmap-modes">
        {['daily', 'weekly', 'cumulative'].map((m) => (
          <button key={m} className={'heatmap-tab' + (mode === m ? ' active' : '')} onClick={() => setMode(m)}>
            {{ daily: '每日', weekly: '每周', cumulative: '按月' }[m]}
          </button>
        ))}
        {selProvider !== 'all' && selProvider !== 'deepseek' ? <span className="heatmap-local-only">仅本机</span> : null}
      </div>
      {mode === 'daily' ? renderDaily() : null}
      {mode === 'weekly' ? renderWeekly() : null}
      {mode === 'cumulative' ? renderMonthly() : null}
      {mode !== 'cumulative' ? monthRow : null}
      <div className="heatmap-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="heatmap-legend-cell" style={{ background: 'rgba(255,250,0,' + LEVEL_ALPHA[l] + ')' }} />
        ))}
        <span>多</span>
      </div>
      {tip ? (
        <div ref={tipRef} className={'heatmap-tooltip' + (tip.below ? ' below' : '') + (tip.fading ? ' fading' : '')} style={{ left: tip.x, top: tip.y }}>
          <div className="heatmap-tooltip-head">
            <span className="heatmap-tooltip-date">{tipLabel(tip.date)}</span>
            <span className="heatmap-tooltip-total">{formatToken(tipTotal(tip.date))} Token</span>
          </div>
          {(tip.overrideLines || tipLines(tip.date)).map((l, i) => (
            <div key={i} className="heatmap-tooltip-row">
              <span className="heatmap-tooltip-label">{l.label}</span>
              <span className="heatmap-tooltip-value">{l.value}</span>
            </div>
          ))}
          {!(tip.overrideLines || tipLines(tip.date)).length ? <div className="heatmap-tooltip-row">无消耗</div> : null}
        </div>
      ) : null}
    </div>
  );
}
