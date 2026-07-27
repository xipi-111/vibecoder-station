const path = require("node:path");
const fs = require("node:fs");
const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  screen,
  session,
} = require("electron");
const { loadResolverToken } = require("./credential-store.cjs");
const { DouyinLocalSource } = require("./douyin-local-source.cjs");
const { LocalDouyinClient } = require("./local-douyin-client.cjs");
const { MediaTransport } = require("./media-transport.cjs");
const { QueueService } = require("./queue-service.cjs");
const { ResolverClient } = require("./resolver-client.cjs");

const MEDIA_SCHEME = "vibecoder-media";
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;

let mainWindow = null;
let queueService = null;
let localDouyinClient = null;

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
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;

  const frameUrl = event.senderFrame?.url ?? "";
  try {
    const parsed = new URL(frameUrl);
    if (DEV_SERVER_URL) {
      return parsed.origin === new URL(DEV_SERVER_URL).origin;
    }

    const expectedPath = path.join(__dirname, "..", "dist", "index.html");
    return (
      parsed.protocol === "file:" &&
      decodeURIComponent(parsed.pathname) === expectedPath
    );
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.handle("window:close", (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    mainWindow?.close();
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

  ipcMain.handle("douyin:get-status", async (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    if (!localDouyinClient) return { available: false };
    return {
      available: true,
      ...(await localDouyinClient.getStatus()),
    };
  });

  ipcMain.handle("douyin:login", async (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    if (!localDouyinClient) {
      throw new Error("当前使用外部解析服务，不需要应用内抖音登录");
    }
    return {
      available: true,
      ...(await localDouyinClient.login()),
    };
  });

  ipcMain.handle("creators:list", (event) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    if (!localDouyinClient) return { available: false, creators: [] };
    return { available: true, ...localDouyinClient.listCreators() };
  });

  ipcMain.handle("creators:add", async (event, input) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    if (!localDouyinClient) {
      throw new Error("外部解析服务模式下请在服务端配置博主");
    }
    const value = String(input ?? "").slice(0, 4_096);
    return {
      available: true,
      ...(await localDouyinClient.addCreator(value)),
    };
  });

  ipcMain.handle("creators:remove", async (event, secUid) => {
    if (!isTrustedSender(event)) throw new Error("拒绝未授权的 IPC 请求");
    if (!localDouyinClient) {
      throw new Error("外部解析服务模式下请在服务端配置博主");
    }
    return {
      available: true,
      ...(await localDouyinClient.removeCreator(String(secUid ?? ""))),
    };
  });
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
    mainWindow = null;
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  const resolverUrl = process.env.VIBECODER_RESOLVER_URL;
  const token = await loadResolverToken(app.getPath("userData"), resolverUrl);
  let resolverClient;

  if (resolverUrl) {
    resolverClient = new ResolverClient({
      baseUrl: resolverUrl,
      token,
    });
  } else {
    const bundledConfigPath = path.join(
      __dirname,
      "config",
      "creators.json",
    );
    const userConfigPath = path.join(
      app.getPath("userData"),
      "douyin-creators.json",
    );
    let config;
    try {
      config = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[douyin-config] 用户配置无效，使用内置配置", error);
      }
      config = JSON.parse(fs.readFileSync(bundledConfigPath, "utf8"));
    }
    localDouyinClient = new LocalDouyinClient({
      source: new DouyinLocalSource(),
      config,
      configPath: userConfigPath,
      userDataPath: app.getPath("userData"),
    });
    resolverClient = localDouyinClient;
    localDouyinClient.startPolling();
  }
  const mediaTransport = new MediaTransport({ resolverClient });

  protocol.handle(MEDIA_SCHEME, (request) => mediaTransport.handle(request));
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  queueService = new QueueService({
    resolverClient,
    mediaTransport,
    mediaDirectory: path.join(__dirname, "..", "dist", "media"),
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
  localDouyinClient?.stopPolling();
});
