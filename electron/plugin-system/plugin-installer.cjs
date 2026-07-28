const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const AdmZip = require("adm-zip");
const { validatePluginManifest } = require("./manifest.cjs");

const REGISTRY_FILENAME = "installed-plugins.json";
const MANIFEST_FILENAME = "plugin.json";
const MAX_PLUGIN_BYTES = 25 * 1024 * 1024;

function safeEntryName(value) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`插件包包含不安全的文件路径：${value}`);
  }
  return normalized;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

class PluginInstaller {
  constructor({ userDataPath }) {
    this.userDataPath = userDataPath;
    this.installRoot = path.join(userDataPath, "plugins");
    this.dataRoot = path.join(userDataPath, "plugin-data");
    this.registryPath = path.join(userDataPath, REGISTRY_FILENAME);
  }

  async loadRegistry() {
    try {
      const stored = JSON.parse(await fs.readFile(this.registryPath, "utf8"));
      return {
        plugins: Array.isArray(stored.plugins) ? stored.plugins : [],
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[plugins] 无法读取插件注册表", error);
      }
      return { plugins: [] };
    }
  }

  async saveRegistry(registry) {
    await fs.mkdir(this.userDataPath, { recursive: true });
    await fs.writeFile(
      this.registryPath,
      JSON.stringify(registry, null, 2),
      { mode: 0o600 },
    );
  }

  async installPackage(packagePath) {
    const packageBuffer = await fs.readFile(packagePath);
    const packageHash = crypto
      .createHash("sha256")
      .update(packageBuffer)
      .digest("hex");
    const archive = new AdmZip(packageBuffer);
    const entries = archive.getEntries();
    let totalBytes = 0;
    let manifestEntry = null;

    for (const entry of entries) {
      const entryName = safeEntryName(entry.entryName);
      totalBytes += Number(entry.header?.size ?? 0);
      if (totalBytes > MAX_PLUGIN_BYTES) {
        throw new Error("插件解压后超过 25 MB 安全限制");
      }
      if (entryName === MANIFEST_FILENAME && !entry.isDirectory) {
        manifestEntry = entry;
      }
    }

    if (!manifestEntry) {
      throw new Error("插件包根目录缺少 plugin.json");
    }

    const manifest = validatePluginManifest(
      JSON.parse(manifestEntry.getData().toString("utf8")),
    );
    await fs.mkdir(this.installRoot, { recursive: true });
    const stagingPath = await fs.mkdtemp(
      path.join(this.installRoot, ".installing-"),
    );

    try {
      for (const entry of entries) {
        const entryName = safeEntryName(entry.entryName);
        const destination = path.join(stagingPath, ...entryName.split("/"));
        if (entry.isDirectory) {
          await fs.mkdir(destination, { recursive: true });
        } else {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, entry.getData(), { mode: 0o600 });
        }
      }

      const mainPath = path.join(
        stagingPath,
        ...manifest.main.split("/"),
      );
      if (!(await pathExists(mainPath))) {
        throw new Error(`插件入口文件不存在：${manifest.main}`);
      }

      const targetPath = path.join(
        this.installRoot,
        manifest.id,
        manifest.version,
      );
      if (await pathExists(targetPath)) {
        throw new Error(
          `${manifest.name} ${manifest.version} 已经安装`,
        );
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.rename(stagingPath, targetPath);

      const registry = await this.loadRegistry();
      const record = {
        id: manifest.id,
        version: manifest.version,
        directory: path.relative(this.installRoot, targetPath),
        packageHash,
        installedAt: new Date().toISOString(),
      };
      registry.plugins = [
        ...registry.plugins.filter((item) => item.id !== manifest.id),
        record,
      ];
      await this.saveRegistry(registry);

      return { manifest, record, installPath: targetPath };
    } catch (error) {
      await fs.rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  resolveInstallation(record) {
    const directory = safeEntryName(record.directory);
    const installPath = path.join(
      this.installRoot,
      ...directory.split("/"),
    );
    const relative = path.relative(this.installRoot, installPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`插件安装目录越界：${record.id}`);
    }
    return installPath;
  }
}

module.exports = {
  PluginInstaller,
};
