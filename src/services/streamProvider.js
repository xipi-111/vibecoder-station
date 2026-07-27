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

  async getDouyinStatus() {
    const bridge = desktopBridge();
    return bridge?.getDouyinStatus
      ? bridge.getDouyinStatus()
      : { available: false };
  },

  async loginDouyin() {
    const bridge = desktopBridge();
    if (!bridge?.loginDouyin) throw new Error("仅桌面应用支持抖音登录");
    return bridge.loginDouyin();
  },

  async closeWindow() {
    const bridge = desktopBridge();
    if (bridge?.closeWindow) return bridge.closeWindow();
    window.close();
    return true;
  },

  async openCreatorManager() {
    const bridge = desktopBridge();
    if (!bridge?.openCreatorManager) {
      throw new Error("仅桌面应用支持独立博主管理窗口");
    }
    return bridge.openCreatorManager();
  },

  async listCreators() {
    const bridge = desktopBridge();
    return bridge?.listCreators
      ? bridge.listCreators()
      : { available: false, creators: [] };
  },

  async addCreator(input) {
    const bridge = desktopBridge();
    if (!bridge?.addCreator) throw new Error("仅桌面应用支持博主管理");
    return bridge.addCreator(input);
  },

  async removeCreator(secUid) {
    const bridge = desktopBridge();
    if (!bridge?.removeCreator) throw new Error("仅桌面应用支持博主管理");
    return bridge.removeCreator(secUid);
  },
};
