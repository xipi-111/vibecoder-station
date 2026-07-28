const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");
const {
  PluginHost,
  parseGlobalItemId,
} = require("./plugin-host.cjs");

async function main() {
  const testDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-plugin-smoke-"),
  );
  const packagePath = path.join(testDirectory, "test.vibeplugin");
  const archive = new AdmZip();
  archive.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        apiVersion: 1,
        id: "com.vibecoder.test",
        name: "测试内容源",
        version: "1.0.0",
        main: "main.cjs",
        capabilities: { queue: true, collections: true },
      }),
    ),
  );
  archive.addFile(
    "main.cjs",
    Buffer.from(`
      exports.createPlugin = async () => ({
        next: async () => ({
          id: "item-1",
          kind: "video",
          priority: "new"
        }),
        resolve: async (id) => ({
          id,
          kind: "video",
          media: { url: "https://example.com/video.mp4" }
        }),
        getQueueInfo: async () => ({ hasNew: true }),
        listCollections: async () => ({
          items: [{ id: "feed-1", name: "测试集合" }]
        })
      });
    `),
  );
  archive.writeZip(packagePath);

  const host = new PluginHost({ userDataPath: testDirectory });
  try {
    await host.initialize();
    if (host.enabled) throw new Error("空播放器不应包含内置插件");

    const installed = await host.installPackage(packagePath);
    if (
      installed.installed.id !== "com.vibecoder.test" ||
      installed.plugins.length !== 1
    ) {
      throw new Error("插件安装结果不正确");
    }

    const queued = await host.next(null);
    const parsed = parseGlobalItemId(queued.id);
    if (
      parsed?.pluginId !== "com.vibecoder.test" ||
      parsed.itemId !== "item-1"
    ) {
      throw new Error("播放器没有为插件作品添加来源命名空间");
    }

    const resolved = await host.resolve(queued.id);
    if (resolved.media?.url !== "https://example.com/video.mp4") {
      throw new Error("媒体解析没有路由回对应插件");
    }

    const collections = await host.listCollections("com.vibecoder.test");
    if (collections.items?.[0]?.id !== "feed-1") {
      throw new Error("插件配置能力没有正确暴露");
    }

    console.log(
      JSON.stringify({
        result: "passed",
        bundledPlugins: 0,
        installedPlugins: 1,
        namespacedQueue: true,
      }),
    );
  } finally {
    await host.stop();
    await fs.rm(testDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
