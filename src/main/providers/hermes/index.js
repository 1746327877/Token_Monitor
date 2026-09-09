// Hermes Provider 适配器(纯本地通道:读 hermes state.db 的会话模型用量)。
// Hermes 是独立 harness,直连 commandcode/opencode-go 等 provider;行级增量合并进 usageDaily。
const { readHermesUsage, getStats } = require('./locallog');

module.exports = {
  id: 'hermes',
  displayName: 'Hermes',
  capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },

  // hermes 为本地工具,无登录态,恒为 ok。
  authStatus() {
    return 'ok';
  },

  // ctx.store 需含 usageDaily 与基线键;dbPath 可经 'providers.hermes.dbPath' 覆盖(测试用)。
  readLocalLog(ctx) {
    const store = ctx && ctx.store;
    const dbPath = (store && store.get('providers.hermes.dbPath'))
      || (ctx && ctx.hermesDbPath)
      || require('./locallog').DEFAULT_DB_PATH();
    return readHermesUsage(store, dbPath, ctx && ctx.logger);
  },

  getStats
};
