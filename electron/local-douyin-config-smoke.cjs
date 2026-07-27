const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalDouyinClient } = require("./local-douyin-client.cjs");

async function main() {
  const testDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-config-smoke-"),
  );
  const configPath = path.join(testDirectory, "douyin-creators.json");
  const creator = {
    name: "测试博主",
    secUid: "MS4wLjAB_test_creator_1234567890",
    shareUrl: "https://www.douyin.com/user/test",
  };
  const source = {
    isAuthenticated: async () => false,
    resolveCreatorProfile: async () => creator,
    fetchCreatorVideos: async () => [
      {
        id: "7665159402169023419",
        authorName: creator.name,
        publishedAt: "2026-07-27T00:00:00.000Z",
      },
    ],
  };

  try {
    const client = new LocalDouyinClient({
      source,
      config: {
        pollIntervalMinutes: 15,
        creators: [],
        seedVideos: [],
      },
      configPath,
      userDataPath: testDirectory,
    });

    const added = await client.addCreator(creator.shareUrl);
    if (!added.added || added.creators.length !== 1) {
      throw new Error("添加博主没有写入配置");
    }

    const stored = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (stored.creators[0]?.secUid !== creator.secUid) {
      throw new Error("持久化的博主配置不正确");
    }

    const removed = await client.removeCreator(creator.secUid);
    if (!removed.removed || removed.creators.length !== 0) {
      throw new Error("删除博主没有更新配置");
    }

    console.log(
      JSON.stringify({
        result: "passed",
        add: true,
        persist: true,
        remove: true,
      }),
    );
  } finally {
    await fs.rm(testDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
