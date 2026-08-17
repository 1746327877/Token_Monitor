const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadVisibility() {
  return import('../renderer/src/grid/visibility.js');
}

test('disabled registered components are excluded without mutating layout records', async () => {
  const { visibleComponentIds } = await loadVisibility();
  const layout = {
    items: [
      { id: 'token-line', x: 0, y: 30, w: 12, h: 6 },
      { id: 'cost-line', x: 0, y: 36, w: 12, h: 6 }
    ]
  };
  const before = JSON.parse(JSON.stringify(layout));

  const visible = visibleComponentIds({
    components: { tokenLine: false, costLine: true }
  });

  assert.equal(visible.includes('token-line'), false);
  assert.equal(visible.includes('cost-line'), true);
  assert.deepEqual(layout, before);
});

test('missing component settings use registry defaults and false remains false', async () => {
  const { visibleComponentIds } = await loadVisibility();

  const defaults = visibleComponentIds({});
  assert.equal(defaults.includes('token-line'), true);

  const disabled = visibleComponentIds({ components: { costLine: false } });
  assert.equal(disabled.includes('cost-line'), false);
});

test('platform toggles hide that platform component cards', async () => {
  const { visibleComponentIds } = await loadVisibility();

  const hideCodex = visibleComponentIds({ components: { platformCodex: false } });
  assert.equal(hideCodex.includes('quota-codex'), false);
  assert.equal(hideCodex.includes('quota-kimi'), true);
  assert.equal(hideCodex.includes('quota-opencode-go'), true);

  const hideGo = visibleComponentIds({ components: { platformOpenCodeGo: false } });
  assert.equal(hideGo.includes('quota-opencode-go'), false);

  const hideGoat = visibleComponentIds({ components: { platformCommandGoat: false } });
  assert.equal(hideGoat.includes('quota-command-goat'), false);
  assert.equal(hideGoat.includes('quota-opencode-go'), true);

  const hideDeepseek = visibleComponentIds({ components: { platformDeepseek: false } });
  assert.equal(hideDeepseek.includes('balance-card'), false);
  assert.equal(hideDeepseek.includes('today-cost-card'), false);
  assert.equal(hideDeepseek.includes('cache-rate-card'), false);
  assert.equal(hideDeepseek.includes('model-bar'), false);

  const hideOpenCode = visibleComponentIds({ components: { platformOpenCode: false } });
  assert.equal(hideOpenCode.includes('opencode-stats-card'), false);

  // 聚合类组件(每日堆叠/趋势/热力图)不受平台开关影响
  const agg = visibleComponentIds({ components: { platformCodex: false, platformKimi: false, platformDeepseek: false } });
  assert.equal(agg.includes('provider-bar'), true);
  assert.equal(agg.includes('token-heatmap'), true);
});

test('saving rendered nodes preserves geometry for hidden or unavailable modules', async () => {
  const { mergeLayoutItems } = await loadVisibility();
  const existing = [
    { id: 'token-line', x: 2, y: 28, w: 10, h: 8, preset: 'tall' },
    { id: 'cost-line', x: 0, y: 36, w: 12, h: 6, preset: 'full' }
  ];
  const savedVisible = [
    { id: 'cost-line', x: 0, y: 30, w: 12, h: 8, preset: 'tall' }
  ];

  const merged = mergeLayoutItems(existing, savedVisible);

  assert.deepEqual(merged, [
    { id: 'token-line', x: 2, y: 28, w: 10, h: 8, preset: 'tall' },
    { id: 'cost-line', x: 0, y: 30, w: 12, h: 8, preset: 'tall' }
  ]);
  assert.notStrictEqual(merged[0], existing[0]);
});

test('Dashboard subscribes to settings and filters GridStack nodes by visible IDs', () => {
  const dashboardSource = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/Dashboard.jsx'),
    'utf8'
  );

  assert.match(dashboardSource, /visibleComponentIds/);
  assert.match(dashboardSource, /mergeLayoutItems/);
  assert.match(dashboardSource, /settings:loaded/);
  assert.match(dashboardSource, /visibleIds\.has\(item\.id\)/);
});
