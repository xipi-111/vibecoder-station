const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalDouyinClient } = require("../plugins/douyin/client.cjs");

function creator(index) {
  return {
    name: `规模测试博主 ${index}`,
    secUid: `MS4wLjAB_scaling_creator_${String(index).padStart(3, "0")}`,
    shareUrl: `https://www.douyin.com/user/scaling-${index}`,
  };
}

async function main() {
  const testDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-scaling-smoke-"),
  );
  const creators = Array.from({ length: 100 }, (_, index) =>
    creator(index + 1),
  );
  const calls = [];
  const batchCalls = [];
  let closed = false;
  const source = {
    isAuthenticated: async () => false,
    close: () => {
      closed = true;
    },
    fetchCreatorLatestBatch: async (items, options) => {
      batchCalls.push({ items, options });
      return items.map((item) => {
        const suffix = String(
          creators.findIndex(
            (candidate) => candidate.secUid === item.secUid,
          ) + 1,
        ).padStart(3, "0");
        const videos = [
          {
            id: `7000000000000000${suffix}`,
            authorName: item.name,
            publishedAt: "2026-07-28T00:00:00.000Z",
          },
        ];
        Object.defineProperty(videos, "complete", {
          value: false,
        });
        return {
          creator: item,
          videos,
          loginRequired: false,
          error: null,
          throttled: false,
        };
      });
    },
  };

  try {
    const client = new LocalDouyinClient({
      source,
      config: {
        pollIntervalMinutes: 15,
        creators,
        seedVideos: [],
      },
      configPath: path.join(testDirectory, "douyin-creators.json"),
      userDataPath: testDirectory,
    });

    await client.initialize();
    await client.refresh();
    while (batchCalls.length < Math.ceil(creators.length / 4)) {
      await client.refresh();
    }

    if (
      calls.length !== 0 ||
      batchCalls.length !== Math.ceil(creators.length / 4) ||
      batchCalls.some(
        (call) =>
          call.items.length > 4 ||
          call.options?.concurrency !== 1,
      )
    ) {
      throw new Error("大量博主没有使用四个一组的分段同步");
    }

    const status = await client.getStatus();
    if (
      status.catalogCount !== creators.length ||
      status.syncProcessed !== creators.length ||
      status.syncTotal !== creators.length
    ) {
      throw new Error("大量博主快速同步的目录或进度不正确");
    }

    const stored = JSON.parse(
      await fs.readFile(
        path.join(testDirectory, "douyin-queue-state.json"),
        "utf8",
      ),
    );
    if (stored.knownIds.length !== creators.length) {
      throw new Error("大量博主的快速同步进度没有持久化");
    }

    client.stopPolling();
    if (!closed) throw new Error("停止插件时没有关闭共享目录页面");

    console.log(
      JSON.stringify({
        result: "passed",
        creators: creators.length,
        pagesPerCreator: 1,
        batchSize: 4,
        persisted: stored.knownIds.length,
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
