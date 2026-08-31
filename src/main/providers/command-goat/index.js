// Command Goat Provider 适配器(quota + 使用统计):登录 Studio 后抓取用量仪表 DOM。
// 支持双号:authStatus 检查任意号是否登录。
const { fetchQuota, getStats, readCred, listAccounts } = require('./auth');

module.exports = {
  id: 'command-goat',
  displayName: 'Command Goat',
  capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },

  authStatus(ctx) {
    const cred1 = readCred(ctx && ctx.store, '1');
    const cred2 = readCred(ctx && ctx.store, '2');
    if ((cred1 && cred1.capturedAt) || (cred2 && cred2.capturedAt)) return 'ok';
    return 'missing';
  },

  fetchQuota,

  getStats,

  listAccounts
};
