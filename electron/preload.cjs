const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "vibecoderDesktop",
  Object.freeze({
    platform: process.platform,
    closeWindow: () => ipcRenderer.invoke("window:close"),
    getInitialStream: () => ipcRenderer.invoke("stream:get-initial"),
    getNextStream: (currentId) =>
      ipcRenderer.invoke("stream:get-next", String(currentId ?? "")),
    getDouyinStatus: () => ipcRenderer.invoke("douyin:get-status"),
    loginDouyin: () => ipcRenderer.invoke("douyin:login"),
    listCreators: () => ipcRenderer.invoke("creators:list"),
    addCreator: (input) =>
      ipcRenderer.invoke("creators:add", String(input ?? "")),
    removeCreator: (secUid) =>
      ipcRenderer.invoke("creators:remove", String(secUid ?? "")),
  }),
);
