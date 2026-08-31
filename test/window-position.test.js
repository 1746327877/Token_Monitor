const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureWindowOnScreen, visibleRatio } = require('../src/main/core/window-position');

// 单屏 1707x1067(用户回家只有一块屏的场景)
const ONE_SCREEN = [{ x: 0, y: 0, width: 1707, height: 1067 }];
// 双屏:主屏 1920x1080 左边 + 副屏 1920x1080 右边
const DUAL_SCREEN = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1920, height: 1080 }
];

test('visibleRatio returns 0 for fully off-screen', () => {
  assert.equal(visibleRatio({ x: 5000, y: 0, width: 781, height: 516 }, { x: 0, y: 0, width: 1707, height: 1067 }), 0);
});

test('visibleRatio returns 1 for fully inside', () => {
  assert.equal(visibleRatio({ x: 100, y: 100, width: 500, height: 400 }, { x: 0, y: 0, width: 1707, height: 1067 }), 1);
});

test('window remembered on secondary monitor returns moved to nearest screen when only primary exists', () => {
  // 双屏时代的副屏位置(1620 在双屏里其实在第一屏……构造更极端:副屏 x=1920+200)
  const bounds = { x: 2100, y: 100, width: 781, height: 516 };
  const corrected = ensureWindowOnScreen(bounds, ONE_SCREEN, 0.05);
  // 必须落在单屏内
  assert.ok(corrected.x >= 0 && corrected.x + corrected.width <= 1707, 'x 在屏内');
  assert.ok(corrected.y + corrected.height <= 1067, 'y 在屏内');
  assert.equal(corrected.width, 781);
  assert.equal(corrected.height, 516);
});

test('window already visible on primary stays put', () => {
  const bounds = { x: 100, y: 100, width: 781, height: 516 };
  const corrected = ensureWindowOnScreen(bounds, ONE_SCREEN, 0.05);
  assert.deepEqual(corrected, bounds);
});

test('dual-screen setup: window on secondary stays on secondary', () => {
  const bounds = { x: 2000, y: 200, width: 780, height: 500 };
  const corrected = ensureWindowOnScreen(bounds, DUAL_SCREEN, 0.05);
  // 副屏 x∈[1920,3840],不强制挪回主屏
  assert.ok(corrected.x >= 1920, '仍在副屏:' + corrected.x);
});

test('undefined position centers on primary', () => {
  const corrected = ensureWindowOnScreen({ width: 800, height: 600 }, DUAL_SCREEN, 0.05);
  // 应居中到第一块屏(主屏)
  assert.equal(corrected.x, Math.round((1920 - 800) / 2));
  assert.equal(corrected.y, Math.round((1080 - 600) / 2));
});

test('tiny visible sliver (below threshold) pulls window back on screen', () => {
  // 只有 1px 露在主屏左边缘 → 视为不可见,拉回
  const bounds = { x: -780, y: 100, width: 781, height: 516 };
  const corrected = ensureWindowOnScreen(bounds, ONE_SCREEN, 0.05);
  assert.ok(corrected.x >= 0, '被拉回屏内 x=' + corrected.x);
});