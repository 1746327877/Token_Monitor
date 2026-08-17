// 组件注册表数据(从 src/renderer/js/layout/component-registry.js 逐字迁移,policy 只依赖 list/get)。
// policy.js 与 layout-policy.test.js 共用的唯一数据源;gridstack 组件类型映射见 Dashboard.jsx。
// 注册表顺序 = 默认布局顺序;OpenCode Go / Command Goat 额度与使用卡置顶。

const components = [
  {
    id: 'quota-opencode-go',
    label: 'OpenCode Go 额度',
    settingsKey: 'components.quotaOpenCodeGo',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ],
      wide: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 0, w: 12, h: 7, preset: 'full' },
      wide: { x: 0, y: 0, w: 12, h: 7, preset: 'full' }
    }
  },
  {
    id: 'quota-command-goat',
    label: 'Command Goat 额度',
    settingsKey: 'components.quotaCommandGoat',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ],
      wide: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 7, w: 12, h: 7, preset: 'full' },
      wide: { x: 0, y: 7, w: 12, h: 7, preset: 'full' }
    }
  },
  {
    id: 'command-goat-stats-card',
    label: 'Command Goat 使用',
    settingsKey: 'components.commandGoatStatsCard',
    defaultVisible: true,
    aspectRatio: 1,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 14, w: 4, h: 4, preset: 'card' },
      wide: { x: 0, y: 14, w: 4, h: 4, preset: 'card' }
    }
  },
  {
    id: 'quota-codex',
    label: 'Codex 额度',
    settingsKey: 'components.quotaCodex',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ],
      wide: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 18, w: 12, h: 7, preset: 'full' },
      wide: { x: 0, y: 18, w: 12, h: 7, preset: 'full' }
    }
  },
  {
    id: 'quota-kimi',
    label: 'Kimi 额度',
    settingsKey: 'components.quotaKimi',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ],
      wide: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 25, w: 12, h: 7, preset: 'full' },
      wide: { x: 0, y: 25, w: 12, h: 7, preset: 'full' }
    }
  },
  {
    id: 'balance-card',
    label: '余额',
    settingsKey: 'components.balanceCard',
    defaultVisible: true,
    aspectRatio: 1,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 32, w: 4, h: 4, preset: 'card' },
      wide: { x: 0, y: 32, w: 4, h: 4, preset: 'card' }
    }
  },
  {
    id: 'today-cost-card',
    label: '今日消耗',
    settingsKey: 'components.todayCostCard',
    defaultVisible: true,
    aspectRatio: 1,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ]
    },
    defaultPlacement: {
      compact: { x: 4, y: 32, w: 4, h: 4, preset: 'card' },
      wide: { x: 4, y: 32, w: 4, h: 4, preset: 'card' }
    }
  },
  {
    id: 'cache-rate-card',
    label: '缓存命中率',
    settingsKey: 'components.cacheRateCard',
    defaultVisible: true,
    aspectRatio: 1,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ]
    },
    defaultPlacement: {
      compact: { x: 8, y: 32, w: 4, h: 4, preset: 'card' },
      wide: { x: 8, y: 32, w: 4, h: 4, preset: 'card' }
    }
  },
  {
    id: 'model-bar',
    label: 'DeepSeek 每日 Token 消耗',
    settingsKey: 'components.modelBar',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 36, w: 12, h: 6, preset: 'full' },
      wide: { x: 0, y: 36, w: 12, h: 6, preset: 'full' }
    }
  },
  {
    id: 'provider-bar',
    label: '每日 Token 消耗',
    settingsKey: 'components.providerBar',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 42, w: 12, h: 6, preset: 'full' },
      wide: { x: 0, y: 42, w: 12, h: 6, preset: 'full' }
    }
  },
  {
    id: 'token-line',
    label: 'Token 消耗趋势',
    settingsKey: 'components.tokenLine',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 48, w: 12, h: 6, preset: 'full' },
      wide: { x: 0, y: 48, w: 12, h: 6, preset: 'full' }
    }
  },
  {
    id: 'cost-line',
    label: '费用增长趋势',
    settingsKey: 'components.costLine',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 6 },
        { name: 'full', w: 12, h: 6 },
        { name: 'tall', w: 12, h: 8 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 54, w: 12, h: 6, preset: 'full' },
      wide: { x: 0, y: 54, w: 12, h: 6, preset: 'full' }
    }
  },
  {
    id: 'token-heatmap',
    label: 'Token 活动',
    settingsKey: 'components.tokenHeatmap',
    defaultVisible: true,
    presets: {
      compact: [
        { name: 'full', w: 12, h: 10 },
        { name: 'half', w: 6, h: 11 },
        { name: 'tall', w: 12, h: 12 }
      ],
      wide: [
        { name: 'full', w: 12, h: 10 },
        { name: 'half', w: 6, h: 11 },
        { name: 'tall', w: 12, h: 12 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 60, w: 12, h: 10, preset: 'full' },
      wide: { x: 0, y: 60, w: 12, h: 10, preset: 'full' }
    }
  },
  {
    id: 'opencode-stats-card',
    label: 'OpenCode 使用',
    settingsKey: 'components.opencodeStatsCard',
    defaultVisible: true,
    aspectRatio: 1,
    presets: {
      compact: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ],
      wide: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ]
    },
    defaultPlacement: {
      compact: { x: 0, y: 70, w: 4, h: 4, preset: 'card' },
      wide: { x: 0, y: 70, w: 4, h: 4, preset: 'card' }
    }
  }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function list() {
  return clone(components);
}

function get(id) {
  const component = components.find((candidate) => candidate.id === id);
  return component ? clone(component) : null;
}

export { list, get };
