import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import AdmZip from "adm-zip";

async function collectFiles(rootPath, currentPath = rootPath) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootPath, absolutePath)));
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        archivePath: path
          .relative(rootPath, absolutePath)
          .split(path.sep)
          .join("/"),
      });
    }
  }
  return files;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error("用法：node scripts/pack-plugin.mjs <插件目录>");
  }

  const pluginPath = path.resolve(input);
  const manifest = JSON.parse(
    await fs.readFile(path.join(pluginPath, "plugin.json"), "utf8"),
  );
  if (!manifest.id || !manifest.version) {
    throw new Error("plugin.json 缺少 id 或 version");
  }

  const outputDirectory = path.resolve("plugin-dist");
  const outputPath = path.join(
    outputDirectory,
    `${manifest.id}-${manifest.version}.vibeplugin`,
  );
  const archive = new AdmZip();
  for (const file of await collectFiles(pluginPath)) {
    archive.addFile(
      file.archivePath,
      await fs.readFile(file.absolutePath),
    );
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  await new Promise((resolve, reject) => {
    archive.writeZip(outputPath, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
