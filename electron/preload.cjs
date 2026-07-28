const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "vibecoderDesktop",
  Object.freeze({
    platform: process.platform,
    closeWindow: () => ipcRenderer.invoke("window:close"),
    openSourceManager: () => ipcRenderer.invoke("plugins:open-manager"),
    getInitialStream: () => ipcRenderer.invoke("stream:get-initial"),
    getNextStream: (currentId) =>
      ipcRenderer.invoke("stream:get-next", String(currentId ?? "")),
    listPlugins: () => ipcRenderer.invoke("plugins:list"),
    installPlugin: () => ipcRenderer.invoke("plugins:install"),
    getPluginStatus: (pluginId) =>
      ipcRenderer.invoke("plugins:get-status", String(pluginId ?? "")),
    loginPlugin: (pluginId) =>
      ipcRenderer.invoke("plugins:login", String(pluginId ?? "")),
    listCollections: (pluginId) =>
      ipcRenderer.invoke("plugins:list-collections", String(pluginId ?? "")),
    addCollection: (pluginId, input) =>
      ipcRenderer.invoke(
        "plugins:add-collection",
        String(pluginId ?? ""),
        String(input ?? ""),
      ),
    removeCollection: (pluginId, collectionId) =>
      ipcRenderer.invoke(
        "plugins:remove-collection",
        String(pluginId ?? ""),
        String(collectionId ?? ""),
      ),
    onPluginsChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("plugins:changed", listener);
      return () => ipcRenderer.removeListener("plugins:changed", listener);
    },
  }),
);
