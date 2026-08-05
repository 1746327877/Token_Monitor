// OpenCode Go Provider 适配器(quota 通道):官方 console 用量,登录捕获后带 Cookie 轮询。
const { fetchQuota } = require('./quota');
const { readCred } = require('./auth');

module.exports = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },

  authStatus(ctx) {
    const cred = readCred(ctx && ctx.store);
    if (!cred || !cred.cookie || !cred.url) return 'missing';
    return 'ok';
  },

  fetchQuota
};
