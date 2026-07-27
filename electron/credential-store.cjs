const fs = require("node:fs/promises");
const path = require("node:path");
const { safeStorage } = require("electron");

const TOKEN_FILE = "resolver-token.bin";

function resolverOrigin(resolverUrl) {
  return new URL(resolverUrl).origin;
}

async function persistToken(filePath, resolverUrl, token) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return;

  const encrypted = await safeStorage.encryptStringAsync(
    JSON.stringify({ origin: resolverOrigin(resolverUrl), token }),
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, encrypted, { mode: 0o600 });
}

async function readStoredToken(filePath, resolverUrl) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;

  try {
    const encrypted = await fs.readFile(filePath);
    const { result, shouldReEncrypt } =
      await safeStorage.decryptStringAsync(encrypted);
    const stored = JSON.parse(result);
    if (stored.origin !== resolverOrigin(resolverUrl)) return null;
    if (shouldReEncrypt) {
      await persistToken(filePath, resolverUrl, stored.token);
    }
    return stored.token;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function loadResolverToken(userDataPath, resolverUrl) {
  if (!resolverUrl) return null;

  const filePath = path.join(userDataPath, TOKEN_FILE);
  const environmentToken = process.env.VIBECODER_RESOLVER_TOKEN?.trim();

  if (environmentToken) {
    await persistToken(filePath, resolverUrl, environmentToken);
    return environmentToken;
  }

  return readStoredToken(filePath, resolverUrl);
}

module.exports = { loadResolverToken };
