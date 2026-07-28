const path = require("node:path");

const PLUGIN_API_VERSION = 1;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertRelativeFile(value, fieldName) {
  const text = String(value ?? "");
  const normalized = path.posix.normalize(text.replaceAll("\\", "/"));
  if (
    !text ||
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`插件清单中的 ${fieldName} 不是安全的相对路径`);
  }
  return normalized;
}

function validatePluginManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("插件包缺少有效的 plugin.json");
  }

  const apiVersion = Number(input.apiVersion);
  const id = String(input.id ?? "");
  const name = String(input.name ?? "").trim();
  const version = String(input.version ?? "");

  if (apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `插件 API 版本不兼容：需要 ${PLUGIN_API_VERSION}，收到 ${input.apiVersion}`,
    );
  }
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error("插件 id 必须是反向域名格式，例如 com.example.source");
  }
  if (!name || name.length > 80) {
    throw new Error("插件名称为空或过长");
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("插件 version 必须使用 x.y.z 格式");
  }

  const capabilities =
    input.capabilities &&
    typeof input.capabilities === "object" &&
    !Array.isArray(input.capabilities)
      ? input.capabilities
      : {};
  const ui =
    input.ui && typeof input.ui === "object" && !Array.isArray(input.ui)
      ? input.ui
      : {};

  return {
    apiVersion,
    id,
    name,
    version,
    description: String(input.description ?? "").slice(0, 240),
    main: assertRelativeFile(input.main ?? "main.cjs", "main"),
    capabilities,
    ui,
  };
}

module.exports = {
  PLUGIN_API_VERSION,
  validatePluginManifest,
};
