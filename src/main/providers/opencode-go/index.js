// OpenCode Go Provider 适配器(quota 通道):登录 console 后,在 /go 页面上下文调 /api/go/status 拿用量。
const { fetchQuota } = require('./auth');
const { readCred } = require('./auth');

module.exports = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },

  authStatus(ctx) {
    const cred = readCred(ctx && ctx.store);
    if (!cred || !cred.workspaceID) return 'missing';
    return 'ok';
  },

  fetchQuota
};
