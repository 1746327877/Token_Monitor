// 窗口位置防护(纯函数,可测试):把窗口 bounds 校正到当前显示器可用区域内,
// 避免外接显示器拔掉后窗口被记忆到屏幕外导致"打不开"。

// 判断窗口与某个显示区域的可视面积占比是否足够(≥ 阈值才算"能看到")。
function visibleRatio(bounds, display) {
  const overlapW = Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
  const overlapH = Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
  if (overlapW <= 0 || overlapH <= 0) return 0;
  const overlap = overlapW * overlapH;
  const total = bounds.width * bounds.height;
  return total > 0 ? overlap / total : 0;
}

// 校正窗口位置:
// 1. 若窗口在任一显示器上有足够可视面积(≥ minVisible),原样返回。
// 2. 否则把窗口移到最近显示器的中心(取与窗口中心距离最近的那个显示器)。
// displays: [{ x, y, width, height }];minVisible 默认 0.05(只要 5% 可见就不动)。
function ensureWindowOnScreen(bounds, displays, minVisible) {
  const b = {
    x: Number(bounds && bounds.x),
    y: Number(bounds && bounds.y),
    width: Number(bounds && bounds.width) || 500,
    height: Number(bounds && bounds.height) || 400
  };
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    // 无位置(首次):居中到主屏(第一块)
    const primary = (displays && displays[0]) || { x: 0, y: 0, width: 1280, height: 720 };
    return {
      x: Math.round(primary.x + (primary.width - b.width) / 2),
      y: Math.round(primary.y + (primary.height - b.height) / 2),
      width: b.width,
      height: b.height
    };
  }

  const lists = Array.isArray(displays) && displays.length ? displays : [{ x: 0, y: 0, width: 1280, height: 720 }];
  const threshold = Number(minVisible) >= 0 ? Number(minVisible) : 0.05;

  // 窗口中心
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;

  let best = null;
  let bestDist = Infinity;
  lists.forEach((d) => {
    if (visibleRatio(b, d) >= threshold) {
      // 已经能看到 → 不动
      best = { x: b.x, y: b.y, width: b.width, height: b.height };
      bestDist = -1;
      return;
    }
    const dcx = d.x + d.width / 2;
    const dcy = d.y + d.height / 2;
    const dist = (cx - dcx) * (cx - dcx) + (cy - dcy) * (cy - dcy);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  });

  if (best && bestDist === -1) {
    // 可见 → 原样
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  const target = best || lists[0];
  // 移到最近显示器内,尽量保留窗口尺寸(显式数值化,杜绝 NaN 泄漏)
  const tw = Number(target && target.width) || 1280;
  const th = Number(target && target.height) || 720;
  const tx = Number(target && target.x) || 0;
  const ty = Number(target && target.y) || 0;
  const w = Math.min(Number(b.width) || 500, tw);
  const h = Math.min(Number(b.height) || 400, th);
  return {
    x: Math.round(tx + (tw - w) / 2),
    y: Math.round(ty + (th - h) / 2),
    width: w,
    height: h
  };
}

module.exports = { ensureWindowOnScreen, visibleRatio };