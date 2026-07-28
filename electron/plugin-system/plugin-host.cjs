const fs = require("node:fs/promises");
const path = require("node:path");
const { PluginInstaller } = require("./plugin-installer.cjs");
const { validatePluginManifest } = require("./manifest.cjs");

const GLOBAL_ID_SEPARATOR = "::";

function randomize(values) {
  return [...values].sort(() => Math.random() - 0.5);
}

function globalItemId(pluginId, itemId) {
  const localId = String(itemId ?? "");
  if (!localId) throw new Error(`插件 ${pluginId} 返回了空作品 id`);
  return `${pluginId}${GLOBAL_ID_SEPARATOR}${localId}`;
}

function parseGlobalItemId(value) {
  const text = String(value ?? "");
  const separatorIndex = text.indexOf(GLOBAL_ID_SEPARATOR);
  if (separatorIndex <= 0) return null;
  return {
    pluginId: text.slice(0, separatorIndex),
    itemId: text.slice(separatorIndex + GLOBAL_ID_SEPARATOR.length),
  };
}

function publicManifest(manifest, error = null) {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    capabilities: manifest.capabilities,
    ui: manifest.ui,
    available: !error,
    error,
  };
}

class PluginHost {
  constructor({ userDataPath }) {
    this.userDataPath = userDataPath;
    this.installer = new PluginInstaller({ userDataPath });
    this.plugins = new Map();
    this.failures = new Map();
  }

  get enabled() {
    return this.plugins.size > 0;
  }

  async initialize() {
    const registry = await this.installer.loadRegistry();
    for (const record of registry.plugins) {
      try {
        await this.loadInstallation(
          this.installer.resolveInstallation(record),
        );
      } catch (error) {
        this.failures.set(record.id, {
          id: record.id,
          name: record.id,
          version: record.version,
          description: "",
          capabilities: {},
          ui: {},
          error: error?.message ?? String(error),
        });
        console.warn(`[plugins] 无法加载 ${record.id}`, error);
      }
    }
    return this.listPlugins();
  }

  async loadInstallation(installPath) {
    const manifest = validatePluginManifest(
      JSON.parse(
        await fs.readFile(path.join(installPath, "plugin.json"), "utf8"),
      ),
    );
    const mainPath = path.join(
      installPath,
      ...manifest.main.split("/"),
    );
    const relativeMainPath = path.relative(installPath, mainPath);
    if (
      relativeMainPath.startsWith("..") ||
      path.isAbsolute(relativeMainPath)
    ) {
      throw new Error(`插件 ${manifest.id} 的入口文件越界`);
    }

    const previous = this.plugins.get(manifest.id);
    await previous?.instance.stop?.();
    delete require.cache[require.resolve(mainPath)];
    const moduleExports = require(mainPath);
    if (typeof moduleExports.createPlugin !== "function") {
      throw new Error(`插件 ${manifest.id} 没有导出 createPlugin()`);
    }

    const dataPath = path.join(
      this.installer.dataRoot,
      manifest.id,
    );
    await fs.mkdir(dataPath, { recursive: true });
    const instance = await moduleExports.createPlugin(
      Object.freeze({
        pluginId: manifest.id,
        pluginPath: installPath,
        dataPath,
        legacyDataPath: this.userDataPath,
      }),
    );

    if (
      !instance ||
      typeof instance.next !== "function" ||
      typeof instance.resolve !== "function"
    ) {
      throw new Error(`插件 ${manifest.id} 没有实现 next() 和 resolve()`);
    }

    this.plugins.set(manifest.id, { manifest, instance, installPath });
    this.failures.delete(manifest.id);
    await instance.start?.();
    return publicManifest(manifest);
  }

  async installPackage(packagePath) {
    const installation = await this.installer.installPackage(packagePath);
    const plugin = await this.loadInstallation(installation.installPath);
    return {
      installed: plugin,
      ...this.listPlugins(),
    };
  }

  listPlugins() {
    const plugins = [
      ...[...this.plugins.values()].map(({ manifest }) =>
        publicManifest(manifest),
      ),
      ...[...this.failures.values()].map((failure) =>
        publicManifest(failure, failure.error),
      ),
    ].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    return { plugins };
  }

  pluginRecord(pluginId) {
    const record = this.plugins.get(String(pluginId ?? ""));
    if (!record) throw new Error("内容源插件不存在或加载失败");
    return record;
  }

  async queueOrder(afterId) {
    const current = parseGlobalItemId(afterId);
    const records = [...this.plugins.entries()];
    const summaries = await Promise.all(
      records.map(async ([pluginId, record]) => {
        try {
          const localAfterId =
            current?.pluginId === pluginId ? current.itemId : null;
          const summary =
            (await record.instance.getQueueInfo?.(localAfterId)) ?? {};
          return { pluginId, record, summary };
        } catch (error) {
          return { pluginId, record, summary: {}, error };
        }
      }),
    );
    const available = summaries.filter((item) => !item.error);
    const newItems = available
      .filter((item) => item.summary.hasNew)
      .sort((left, right) => {
        const leftTime = Date.parse(left.summary.newestPublishedAt ?? "");
        const rightTime = Date.parse(right.summary.newestPublishedAt ?? "");
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
          return rightTime - leftTime;
        }
        if (Number.isFinite(leftTime)) return -1;
        if (Number.isFinite(rightTime)) return 1;
        return 0;
      });
    const rest = available.filter((item) => !item.summary.hasNew);
    return newItems.length
      ? [...newItems, ...randomize(rest)]
      : randomize(rest);
  }

  async next(afterId) {
    const candidates = await this.queueOrder(afterId);
    if (!candidates.length) {
      throw new Error("还没有安装可用的内容源插件");
    }
    const current = parseGlobalItemId(afterId);
    const failures = [];

    for (const candidate of candidates) {
      const localAfterId =
        current?.pluginId === candidate.pluginId ? current.itemId : null;
      try {
        const item = await candidate.record.instance.next(localAfterId);
        return {
          ...item,
          id: globalItemId(candidate.pluginId, item.id),
          pluginId: candidate.pluginId,
        };
      } catch (error) {
        failures.push(
          `${candidate.record.manifest.name}: ${error?.message ?? error}`,
        );
      }
    }

    throw new Error(`所有内容源都无法提供作品：${failures.join("；")}`);
  }

  async resolve(globalId) {
    const parsed = parseGlobalItemId(globalId);
    if (!parsed) throw new Error(`无法识别作品来源：${globalId}`);
    const { instance } = this.pluginRecord(parsed.pluginId);
    const item = await instance.resolve(parsed.itemId);
    return {
      ...item,
      id: globalItemId(parsed.pluginId, item.id ?? parsed.itemId),
      pluginId: parsed.pluginId,
    };
  }

  async getPluginStatus(pluginId) {
    const { instance } = this.pluginRecord(pluginId);
    return {
      available: true,
      ...(await instance.getStatus?.()),
    };
  }

  async loginPlugin(pluginId) {
    const { instance } = this.pluginRecord(pluginId);
    if (typeof instance.login !== "function") {
      throw new Error("这个插件不需要登录");
    }
    return {
      available: true,
      ...(await instance.login()),
    };
  }

  async listCollections(pluginId) {
    const { instance } = this.pluginRecord(pluginId);
    if (typeof instance.listCollections !== "function") {
      return { available: false, items: [] };
    }
    return {
      available: true,
      ...(await instance.listCollections()),
    };
  }

  async addCollection(pluginId, input) {
    const { instance } = this.pluginRecord(pluginId);
    if (typeof instance.addCollection !== "function") {
      throw new Error("这个插件不支持添加内容集合");
    }
    return {
      available: true,
      ...(await instance.addCollection(input)),
    };
  }

  async removeCollection(pluginId, collectionId) {
    const { instance } = this.pluginRecord(pluginId);
    if (typeof instance.removeCollection !== "function") {
      throw new Error("这个插件不支持删除内容集合");
    }
    return {
      available: true,
      ...(await instance.removeCollection(collectionId)),
    };
  }

  async stop() {
    await Promise.allSettled(
      [...this.plugins.values()].map(({ instance }) =>
        instance.stop?.(),
      ),
    );
  }
}

module.exports = {
  PluginHost,
  globalItemId,
  parseGlobalItemId,
};
