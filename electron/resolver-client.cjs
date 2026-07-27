const { net } = require("electron");

function normalizeBaseUrl(value) {
  if (!value) return null;

  const url = new URL(value);
  const isLocalDevelopment =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");

  if (url.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("解析服务必须使用 HTTPS（本机开发地址除外）");
  }

  return url.toString().replace(/\/$/, "");
}

class ResolverClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token || null;
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  async request(pathname, { method = "GET", body } = {}) {
    if (!this.enabled) {
      throw new Error("未配置 VIBECODER_RESOLVER_URL");
    }

    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    const response = await net.fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "follow",
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `解析服务请求失败：${response.status}${detail ? ` ${detail.slice(0, 180)}` : ""}`,
      );
    }

    return response.json();
  }

  next(afterId) {
    return this.request("/v1/queue/next", {
      method: "POST",
      body: { afterId: afterId || null },
    });
  }

  resolve(videoId) {
    return this.request("/v1/media/resolve", {
      method: "POST",
      body: { videoId },
    });
  }
}

module.exports = { ResolverClient };
