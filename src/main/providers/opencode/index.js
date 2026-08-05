// OpenCode Provider 适配器(纯本地通道:读取本机 opencode 会话消息)。
const { readLocalLog, getStats } = require('./locallog');

module.exports = {
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },

  // opencode 为本地工具,无登录态,恒为 ok。
  authStatus() {
    return 'ok';
  },

  readLocalLog,

  getStats
};
