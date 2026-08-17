// Command Goat Provider 适配器(quota + 使用统计):登录 Studio 后抓取用量仪表 DOM。
const { fetchQuota, getStats, readCred } = require('./auth');

module.exports = {
  id: 'command-goat',
  displayName: 'Command Goat',
  capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },

  authStatus(ctx) {
    const cred = readCred(ctx && ctx.store);
    if (!cred || !cred.capturedAt) return 'missing';
    return 'ok';
  },

  fetchQuota,

  getStats
};
