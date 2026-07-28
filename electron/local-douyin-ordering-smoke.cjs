const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalDouyinClient } = require("../plugins/douyin/client.cjs");

const creator = {
  name: "排序测试博主",
  secUid: "MS4wLjAB_ordering_test_creator",
  shareUrl: "https://www.douyin.com/user/ordering-test",
};

function video(id) {
  return {
    id,
    authorName: creator.name,
    publishedAt: null,
  };
}

async function main() {
  const testDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-ordering-smoke-"),
  );
  let catalog = [
    video("7000000000000000003"),
    video("7000000000000000002"),
    video("7000000000000000001"),
  ];
  const source = {
    isAuthenticated: async () => false,
    fetchCreatorVideos: async () => catalog,
  };

  try {
    const client = new LocalDouyinClient({
      source,
      config: {
        pollIntervalMinutes: 15,
        creators: [creator],
        seedVideos: [],
      },
      configPath: path.join(testDirectory, "douyin-creators.json"),
      userDataPath: testDirectory,
    });

    await client.initialize();
    await client.refresh();

    const initialLatest = await client.next(null);
    if (
      initialLatest.id !== "7000000000000000003" ||
      initialLatest.priority !== "new"
    ) {
      throw new Error("首次同步没有只优先最新一条作品");
    }

    const initialHistory = await client.next(initialLatest.id);
    if (initialHistory.priority !== "shuffle") {
      throw new Error("首次同步的历史作品仍被标记为新作品");
    }

    catalog = [
      video("7000000000000000004"),
      ...catalog,
      video("7000000000000000000"),
    ];
    await client.refresh();

    const actualUpdate = await client.next(initialHistory.id);
    if (
      actualUpdate.id !== "7000000000000000004" ||
      actualUpdate.priority !== "new"
    ) {
      throw new Error("首次同步后的真正更新没有得到优先播放");
    }

    const olderHistory = await client.next(actualUpdate.id);
    if (olderHistory.priority !== "shuffle") {
      throw new Error("后来补齐的旧作品被误判为新作品");
    }

    const stored = JSON.parse(
      await fs.readFile(
        path.join(testDirectory, "douyin-queue-state.json"),
        "utf8",
      ),
    );
    if (
      stored.creatorHighWaterMarks?.[creator.secUid] !==
      "7000000000000000004"
    ) {
      throw new Error("没有持久化博主的最新作品基线");
    }

    console.log(
      JSON.stringify({
        result: "passed",
        firstSync: "latest-only",
        updates: "newer-only",
        olderBackfill: "history",
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
