const mockStreams = [
  {
    id: "maker-workshop",
    streamUrl: "/media/maker-workshop.mp4",
    posterUrl: "/media/maker-workshop.png",
    priority: "new",
  },
  {
    id: "indie-developer",
    streamUrl: "/media/indie-developer.mp4",
    posterUrl: "/media/indie-developer.png",
    priority: "shuffle",
  },
  {
    id: "product-sketch",
    streamUrl: "/media/product-sketch.mp4",
    posterUrl: "/media/product-sketch.png",
    priority: "shuffle",
  },
];

let currentIndex = 0;

function desktopBridge() {
  return globalThis.window?.vibecoderDesktop ?? null;
}

export const streamProvider = {
  get isDesktop() {
    return Boolean(desktopBridge());
  },

  getPlaceholder() {
    return desktopBridge() ? null : mockStreams[currentIndex];
  },

  async getInitial() {
    const bridge = desktopBridge();
    return bridge ? bridge.getInitialStream() : mockStreams[currentIndex];
  },

  async getNext(currentId) {
    const bridge = desktopBridge();
    if (bridge) return bridge.getNextStream(currentId);

    currentIndex = (currentIndex + 1) % mockStreams.length;
    return mockStreams[currentIndex];
  },

  async listPlugins() {
    const bridge = desktopBridge();
    return bridge?.listPlugins ? bridge.listPlugins() : { plugins: [] };
  },

  async installPlugin() {
    const bridge = desktopBridge();
    if (!bridge?.installPlugin) throw new Error("仅桌面应用支持安装插件");
    return bridge.installPlugin();
  },

  async closeWindow() {
    const bridge = desktopBridge();
    if (bridge?.closeWindow) return bridge.closeWindow();
    window.close();
    return true;
  },

  async openSourceManager() {
    const bridge = desktopBridge();
    if (!bridge?.openSourceManager) {
      throw new Error("仅桌面应用支持内容源管理窗口");
    }
    return bridge.openSourceManager();
  },

  async getPluginStatus(pluginId) {
    const bridge = desktopBridge();
    return bridge?.getPluginStatus
      ? bridge.getPluginStatus(pluginId)
      : { available: false };
  },

  async loginPlugin(pluginId) {
    const bridge = desktopBridge();
    if (!bridge?.loginPlugin) throw new Error("仅桌面应用支持插件登录");
    return bridge.loginPlugin(pluginId);
  },

  async listCollections(pluginId) {
    const bridge = desktopBridge();
    return bridge?.listCollections
      ? bridge.listCollections(pluginId)
      : { available: false, items: [] };
  },

  async addCollection(pluginId, input) {
    const bridge = desktopBridge();
    if (!bridge?.addCollection) throw new Error("仅桌面应用支持内容源配置");
    return bridge.addCollection(pluginId, input);
  },

  async removeCollection(pluginId, collectionId) {
    const bridge = desktopBridge();
    if (!bridge?.removeCollection) {
      throw new Error("仅桌面应用支持内容源配置");
    }
    return bridge.removeCollection(pluginId, collectionId);
  },

  onPluginsChanged(callback) {
    const bridge = desktopBridge();
    return bridge?.onPluginsChanged
      ? bridge.onPluginsChanged(callback)
      : () => undefined;
  },
};
