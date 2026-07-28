const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalDouyinClient } = require("../plugins/douyin/client.cjs");

const creatorOne = {
  name: "目录缓存博主一",
  secUid: "MS4wLjAB_catalog_cache_creator_one",
  shareUrl: "https://www.douyin.com/user/catalog-cache-one",
};
const creatorTwo = {
  name: "目录缓存博主二",
  secUid: "MS4wLjAB_catalog_cache_creator_two",
  shareUrl: "https://www.douyin.com/user/catalog-cache-two",
};

function completeCatalog(items) {
  items.complete = true;
  return items;
}

function video(id, creator, kind = "video") {
  return {
    id,
    authorName: creator.name,
    authorId: creator.secUid,
    publishedAt: "2026-07-28T00:00:00.000Z",
    kind,
    imageCount: kind === "image" ? 3 : 0,
    shareUrl: `https://www.douyin.com/video/${id}`,
  };
}

async function main() {
  const testDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-catalog-cache-smoke-"),
  );
  const legacyDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-catalog-migration-smoke-"),
  );
  const now = Date.parse("2026-07-28T18:00:00.000Z");
  const configPath = path.join(testDirectory, "config.json");
  const config = {
    pollIntervalMinutes: 180,
    creators: [creatorOne],
    seedVideos: [],
  };
  let initialFetches = 0;

  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    const firstClient = new LocalDouyinClient({
      source: {
        isAuthenticated: async () => true,
        close: () => {},
        fetchCreatorVideos: async (creator, options) => {
          initialFetches += 1;
          if (creator.secUid !== creatorOne.secUid || options) {
            throw new Error("首次目录导入没有完整同步目标博主");
          }
          return completeCatalog([
            video("7000000000000000102", creatorOne, "image"),
            video("7000000000000000101", creatorOne),
          ]);
        },
      },
      config,
      configPath,
      userDataPath: testDirectory,
      now: () => now,
    });
    await firstClient.initialize();
    await firstClient.refresh();
    firstClient.stopPolling();

    const storedCatalog = JSON.parse(
      await fs.readFile(
        path.join(testDirectory, "douyin-catalog.json"),
        "utf8",
      ),
    );
    if (
      initialFetches !== 1 ||
      storedCatalog.schemaVersion !== 1 ||
      storedCatalog.items.length !== 2 ||
      storedCatalog.items[0].authorId !== creatorOne.secUid ||
      "mediaUrl" in storedCatalog.items[0]
    ) {
      throw new Error("没有保存稳定、可复用的完整本地目录");
    }

    const targetedFetches = [];
    let authenticated = false;
    let loginWindows = 0;
    const secondConfig = JSON.parse(
      await fs.readFile(configPath, "utf8"),
    );
    const secondClient = new LocalDouyinClient({
      source: {
        isAuthenticated: async () => authenticated,
        close: () => {},
        openLoginWindow: async () => {
          loginWindows += 1;
          authenticated = true;
          return { authenticated: true };
        },
        resolveCreatorProfile: async () => creatorTwo,
        fetchCreatorVideos: async (creator, options) => {
          targetedFetches.push({ secUid: creator.secUid, options });
          return completeCatalog([
            video("7000000000000000201", creatorTwo),
          ]);
        },
      },
      config: secondConfig,
      configPath,
      userDataPath: testDirectory,
      now: () => now + 60 * 60_000,
    });
    await secondClient.initialize();
    const restoredQueue = await secondClient.getQueueInfo(null);
    if (targetedFetches.length !== 0 || restoredQueue.itemCount !== 2) {
      throw new Error("重启后没有直接使用本地目录");
    }
    const loginStatus = await secondClient.login();
    if (
      !loginStatus.authenticated ||
      loginWindows !== 1 ||
      targetedFetches.length !== 0
    ) {
      throw new Error("缓存目录下登录触发了目录刷新或没有完成登录");
    }

    await secondClient.addCreator(creatorTwo.shareUrl);
    const afterAdd = await secondClient.getQueueInfo(null);
    if (
      targetedFetches.length !== 1 ||
      targetedFetches[0].secUid !== creatorTwo.secUid ||
      targetedFetches[0].options !== undefined ||
      afterAdd.itemCount !== 3
    ) {
      throw new Error("新增博主触发了全局刷新或没有完整导入新目录");
    }

    await secondClient.removeCreator(creatorTwo.secUid);
    const afterRemove = await secondClient.getQueueInfo(null);
    if (targetedFetches.length !== 1 || afterRemove.itemCount !== 2) {
      throw new Error("删除博主触发了网络刷新或清空了其他目录");
    }
    secondClient.stopPolling();

    const legacyId = "7000000000000000301";
    await fs.writeFile(
      path.join(legacyDirectory, "douyin-queue-state.json"),
      JSON.stringify({
        knownIds: [legacyId],
        pendingNewIds: [],
        recentIds: [],
        creatorHighWaterMarks: {},
        catalogCompleteCreatorIds: [],
        refreshCursor: 0,
        catalogTransport: "api",
      }),
    );
    let legacyFetches = 0;
    const legacyClient = new LocalDouyinClient({
      source: {
        isAuthenticated: async () => true,
        close: () => {},
        fetchCreatorVideos: async () => {
          legacyFetches += 1;
          return completeCatalog([]);
        },
      },
      config: {
        pollIntervalMinutes: 15,
        creators: [creatorOne],
        seedVideos: [],
      },
      configPath: path.join(legacyDirectory, "config.json"),
      userDataPath: legacyDirectory,
      now: () => now,
    });
    await legacyClient.initialize();
    const migratedCatalog = JSON.parse(
      await fs.readFile(
        path.join(legacyDirectory, "douyin-catalog.json"),
        "utf8",
      ),
    );
    const migratedConfig = JSON.parse(
      await fs.readFile(
        path.join(legacyDirectory, "config.json"),
        "utf8",
      ),
    );
    if (
      legacyFetches !== 0 ||
      migratedCatalog.items[0]?.id !== legacyId ||
      migratedConfig.pollIntervalMinutes !== 180
    ) {
      throw new Error("旧作品 ID 没有无请求迁移到三小时目录缓存");
    }
    legacyClient.stopPolling();

    console.log(
      JSON.stringify({
        result: "passed",
        cachedItems: storedCatalog.items.length,
        restartRequests: 0,
        loginWithoutRefresh: true,
        targetedAddRequests: targetedFetches.length,
        legacyMigratedWithoutRequests: true,
        pollIntervalMinutes: 180,
      }),
    );
  } finally {
    await fs.rm(testDirectory, { recursive: true, force: true });
    await fs.rm(legacyDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
