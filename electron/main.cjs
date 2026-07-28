const path = require("node:path");
const fs = require("node:fs");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  screen,
  session,
} = require("electron");
const { MediaTransport } = require("./media-transport.cjs");
const { PluginHost } = require("./plugin-system/plugin-host.cjs");
const { QueueService } = require("./queue-service.cjs");

const MEDIA_SCHEME = "vibecoder-media";
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;
const MANAGER_WINDOW_STATE_FILE = "creator-manager-window.json";
const MANAGER_DEFAULT_WIDTH = 410;
const MANAGER_DEFAULT_HEIGHT = 580;
const MANAGER_MIN_WIDTH = 360;
const MANAGER_MIN_HEIGHT = 440;

let mainWindow = null;
let managerWindow = null;
let managerBoundsSaveTimer = null;
let queueService = null;
let pluginHost = null;
let isQuitting = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function isTrustedSender(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (
    !senderWindow ||
    (senderWindow !== mainWindow && senderWindow !== managerWindow)
  ) {
    return false;
  }

  const frameUrl = event.senderFrame?.url ?? "";
  try {
    const parsed = new URL(frameUrl);
    if (DEV_SERVER_URL) {
      return parsed.origin === new URL(DEV_SERVER_URL).origin;
    }

    const expectedFilename =
      senderWindow === managerWindow ? "manager.html" : "index.html";
    const expectedPath = path.join(
      __dirname,
      "..",
      "dist",
      expectedFilename,
    );
    return (
      parsed.protocol === "file:" &&
      decodeURIComponent(parsed.pathname) === expectedPath
    );
  } catch {
    return false;
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function defaultManagerBounds() {
  const anchorBounds =
    mainWindow?.getBounds() ??
    screen.getPrimaryDisplay().workArea;
  const workArea = screen.getDisplayMatching(anchorBounds).workArea;
  const width = Math.min(MANAGER_DEFAULT_WIDTH, workArea.width);
  const height = Math.min(MANAGER_DEFAULT_HEIGHT, workArea.height);
  const rightX = anchorBounds.x + anchorBounds.width + 16;
  const leftX = anchorBounds.x - width - 16;
  const x =
    rightX + width <= workArea.x + workArea.width
      ? rightX
      : leftX >= workArea.x
        ? leftX
        : workArea.x + Math.round((workArea.width - width) / 2);
  const y = clamp(
    anchorBounds.y,
    workArea.y,
    workArea.y + workArea.height - height,
  );
  return { x, y, width, height };
}

function loadManagerBounds() {
  let stored = null;
  try {
    stored = JSON.parse(
      fs.readFileSync(
        path.join(app.getPath("userData"), MANAGER_WINDOW_STATE_FILE),
        "utf8",
      ),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[manager-window] 无法读取窗口位置", error);
    }
  }

  if (
    !stored ||
    !["x", "y", "width", "height"].every((key) =>
      Number.isFinite(stored[key]),
    )
  ) {
    return defaultManagerBounds();
  }

  const display = screen.getDisplayMatching(stored);
  const workArea = display.workArea;
  const width = clamp(
    Math.round(stored.width),
    Math.min(MANAGER_MIN_WIDTH, workArea.width),
    workArea.width,
  );
  const height = clamp(
    Math.round(stored.height),
    Math.min(MANAGER_MIN_HEIGHT, workArea.height),
    workArea.height,
  );
  return {
    x: clamp(
      Math.round(stored.x),
      workArea.x,
      workArea.x + workArea.width - width,
    ),
    y: clamp(
      Math.round(stored.y),
      workArea.y,
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
}

function saveManagerBounds() {
  if (!managerWindow || managerWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(
      path.join(app.getPath("userData"), MANAGER_WINDOW_STATE_FILE),
      JSON.stringify(managerWindow.getNormalBounds(), null, 2),
      { mode: 0o600 },
    );
  } catch (error) {
    console.warn("[manager-window] 无法保存窗口位置", error);
  }
}

function scheduleManagerBoundsSave() {
  if (managerBoundsSaveTimer) clearTimeout(managerBoundsSaveTimer);
  managerBoundsSaveTimer = setTimeout(() => {
    managerBoundsSaveTimer = null;
    saveManagerBounds();
  }, 250);
}

function createManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return managerWindow;
  }

  managerWindow = new BrowserWindow({
    ...loadManagerBounds(),
    minWidth: MANAGER_MIN_WIDTH,
    minHeight: MANAGER_MIN_HEIGHT,
    backgroundColor: "#111111",
    frame: false,
    show: false,
    autoHideMenuBar: true,
    fullscreenable: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: "内容源 · VibeCoder 加油站",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  managerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  managerWindow.webContents.on("will-navigate", (event) =>
    event.preventDefault(),
  );
  managerWindow.once("ready-to-show", () => {
    managerWindow?.show();
    managerWindow?.focus();
  });
  managerWindow.on("move", scheduleManagerBoundsSave);
  managerWindow.on("resize", scheduleManagerBoundsSave);
  managerWindow.on("close", (event) => {
    if (isQuitting || !mainWindow) return;
    event.preventDefault();
    saveManagerBounds();
    managerWindow?.hide();
  });
  managerWindow.on("closed", () => {
    managerWindow = null;
  });

  if (DEV_SERVER_URL) {
    managerWindow.loadURL(new URL("/manager.html", DEV_SERVER_URL).toString());
  } else {
    managerWindow.loadFile(
      path.join(__dirname, "..", "dist", "manager.html"),
    );
  }

  return managerWindow;
}

function registerIpc() {
  ipcMain.handle("window:close", (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (targetWindow === managerWindow) {
      saveManagerBounds();
      managerWindow.hide();
    } else {
      targetWindow?.close();
    }
    return true;
  });

  ipcMain.handle("stream:get-initial", (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    return queueService.getInitial();
  });

  ipcMain.handle("stream:get-next", (event, currentId) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    return queueService.getNext(String(currentId ?? ""));
  });

  ipcMain.handle("plugins:list", (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    return pluginHost.listPlugins();
  });

  ipcMain.handle("plugins:install", async (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    const ownerWindow =
      BrowserWindow.fromWebContents(event.sender) ?? managerWindow ?? mainWindow;
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: "安装 VibeCoder 内容源插件",
      properties: ["openFile"],
      filters: [
        { name: "VibeCoder 插件", extensions: ["vibeplugin"] },
        { name: "ZIP 压缩包", extensions: ["zip"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, ...pluginHost.listPlugins() };
    }
    const installed = await pluginHost.installPackage(result.filePaths[0]);
    mainWindow?.webContents.send("plugins:changed");
    managerWindow?.webContents.send("plugins:changed");
    return installed;
  });

  ipcMain.handle("plugins:get-status", async (event, pluginId) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    return pluginHost.getPluginStatus(String(pluginId ?? ""));
  });

  ipcMain.handle("plugins:login", async (event, pluginId) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    return pluginHost.loginPlugin(String(pluginId ?? ""));
  });

  ipcMain.handle("plugins:list-collections", (event, pluginId) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    return pluginHost.listCollections(String(pluginId ?? ""));
  });

  ipcMain.handle("plugins:open-manager", (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    createManagerWindow();
    return true;
  });

  ipcMain.handle("plugins:add-collection", async (event, pluginId, input) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    const value = String(input ?? "").slice(0, 4_096);
    return pluginHost.addCollection(String(pluginId ?? ""), value);
  });

  ipcMain.handle(
    "plugins:remove-collection",
    async (event, pluginId, collectionId) => {
      if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
      return pluginHost.removeCollection(
        String(pluginId ?? ""),
        String(collectionId ?? ""),
      );
    },
  );
}

function createWindow() {
  const { height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  const height = Math.min(860, Math.max(640, Math.floor(workHeight * 0.86)));
  const width = Math.round((height * 9) / 16);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 360,
    minHeight: 640,
    backgroundColor: "#000000",
    frame: false,
    show: false,
    autoHideMenuBar: true,
    fullscreenable: true,
    title: "VibeCoder 加油站",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.setAspectRatio(9 / 16);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    if (managerWindow && !managerWindow.isDestroyed()) {
      saveManagerBounds();
      managerWindow.destroy();
    }
    mainWindow = null;
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  pluginHost = new PluginHost({ userDataPath: app.getPath("userData") });
  await pluginHost.initialize();
  const mediaTransport = new MediaTransport({ resolverClient: pluginHost });

  protocol.handle(MEDIA_SCHEME, (request) => mediaTransport.handle(request));
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  queueService = new QueueService({
    resolverClient: pluginHost,
    mediaTransport,
  });

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (managerBoundsSaveTimer) clearTimeout(managerBoundsSaveTimer);
  saveManagerBounds();
  pluginHost?.stop();
});
