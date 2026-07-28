const fs = require("node:fs/promises");
const path = require("node:path");
const { DouyinLocalSource } = require("./source.cjs");
const { LocalDouyinClient } = require("./client.cjs");

async function copyIfMissing(sourcePath, destinationPath) {
  try {
    await fs.access(destinationPath);
    return false;
  } catch {
    try {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(sourcePath, destinationPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function createPlugin(context) {
  const configPath = path.join(context.dataPath, "config.json");
  const statePath = path.join(context.dataPath, "douyin-queue-state.json");
  const legacyConfigPath = path.join(
    context.legacyDataPath,
    "douyin-creators.json",
  );
  const legacyStatePath = path.join(
    context.legacyDataPath,
    "douyin-queue-state.json",
  );

  const migratedConfig = await copyIfMissing(
    legacyConfigPath,
    configPath,
  );
  if (!migratedConfig) {
    await copyIfMissing(
      path.join(context.pluginPath, "default-config.json"),
      configPath,
    );
  }
  await copyIfMissing(legacyStatePath, statePath);

  const client = new LocalDouyinClient({
    source: new DouyinLocalSource({
      partition: "persist:vibecoder-douyin-public",
    }),
    config: await readJson(configPath),
    configPath,
    userDataPath: context.dataPath,
  });

  const collectionResult = (result) => ({
    items: (result.creators ?? []).map((creator) => ({
      id: creator.secUid,
      name: creator.name || "抖音博主",
      subtitle: creator.secUid.slice(-8),
      shareUrl: creator.shareUrl,
    })),
    refreshing: Boolean(result.refreshing),
    added: result.added,
    removed: result.removed,
  });

  return {
    start() {
      client.startPolling();
    },

    stop() {
      client.stopPolling();
    },

    getQueueInfo(afterId) {
      return client.getQueueInfo(afterId);
    },

    next(afterId) {
      return client.next(afterId);
    },

    resolve(itemId) {
      return client.resolve(itemId);
    },

    getStatus() {
      return client.getStatus();
    },

    login() {
      return client.login();
    },

    listCollections() {
      return collectionResult(client.listCreators());
    },

    async addCollection(input) {
      return collectionResult(await client.addCreator(input));
    },

    async removeCollection(collectionId) {
      return collectionResult(
        await client.removeCreator(collectionId),
      );
    },
  };
}

module.exports = { createPlugin };
