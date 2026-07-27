const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { net } = require("electron");

const REFRESH_SKEW_MS = 30_000;
const RETRYABLE_STATUS = new Set([401, 403, 410]);
const UPSTREAM_HEADER_ALLOWLIST = new Set([
  "authorization",
  "cookie",
  "origin",
  "referer",
  "user-agent",
]);

const MIME_BY_EXTENSION = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".webm", "video/webm"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function errorResponse(status, message) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { invalid: true };

  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  let start;
  let end;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return { invalid: true };
  }

  return { start, end: Math.min(end, size - 1) };
}

function isExpired(descriptor) {
  if (!descriptor?.expiresAt) return false;

  const expiresAt =
    typeof descriptor.expiresAt === "number"
      ? descriptor.expiresAt
      : Date.parse(descriptor.expiresAt);

  return Number.isFinite(expiresAt) && Date.now() >= expiresAt - REFRESH_SKEW_MS;
}

function normalizeRemoteDescriptor(input) {
  const descriptor = input?.media ?? input;
  if (!descriptor?.url) {
    throw new Error("解析服务没有返回 media.url");
  }

  const url = new URL(descriptor.url);
  if (url.protocol !== "https:") {
    throw new Error("远程媒体地址必须使用 HTTPS");
  }

  return {
    url: url.toString(),
    headers: descriptor.headers ?? {},
    mimeType: descriptor.mimeType ?? null,
    expiresAt: descriptor.expiresAt ?? null,
  };
}

class MediaTransport {
  constructor({ resolverClient }) {
    this.resolverClient = resolverClient;
    this.entries = new Map();
    this.pendingResolutions = new Map();
  }

  registerItem(item) {
    const current = this.entries.get(item.id) ?? {};
    this.entries.set(item.id, {
      ...current,
      video: item.media
        ? normalizeRemoteDescriptor(item.media)
        : current.video ?? null,
      poster: item.posterMedia
        ? normalizeRemoteDescriptor(item.posterMedia)
        : current.poster ?? null,
    });
  }

  registerLocalItem({ id, mediaPath, posterPath }) {
    this.entries.set(id, {
      video: { localPath: mediaPath },
      poster: posterPath ? { localPath: posterPath } : null,
    });
  }

  invalidate(videoId) {
    const entry = this.entries.get(videoId);
    if (entry) entry.video = null;
  }

  async resolveVideo(videoId, force = false) {
    const entry = this.entries.get(videoId) ?? {};
    if (!force && entry.video && !isExpired(entry.video)) {
      return entry.video;
    }

    if (!this.resolverClient.enabled) {
      throw new Error(`本地目录中不存在视频：${videoId}`);
    }

    if (!force && this.pendingResolutions.has(videoId)) {
      return this.pendingResolutions.get(videoId);
    }

    const pending = this.resolverClient
      .resolve(videoId)
      .then((result) => {
        const descriptor = normalizeRemoteDescriptor(result);
        this.entries.set(videoId, { ...entry, video: descriptor });
        return descriptor;
      })
      .finally(() => this.pendingResolutions.delete(videoId));

    this.pendingResolutions.set(videoId, pending);
    return pending;
  }

  async localFileResponse(filePath, request) {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) return errorResponse(404, "媒体文件不存在");

    const range = parseRange(request.headers.get("range"), stat.size);
    if (range?.invalid) {
      return new Response(null, {
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${stat.size}`,
        },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(end - start + 1),
      "content-type":
        MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ??
        "application/octet-stream",
    });

    if (range) {
      headers.set("content-range", `bytes ${start}-${end}/${stat.size}`);
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: range ? 206 : 200, headers });
    }

    const nodeStream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(nodeStream), {
      status: range ? 206 : 200,
      headers,
    });
  }

  buildUpstreamHeaders(descriptor, request) {
    const headers = new Headers();

    for (const [name, value] of Object.entries(descriptor.headers ?? {})) {
      if (UPSTREAM_HEADER_ALLOWLIST.has(name.toLowerCase())) {
        headers.set(name, String(value));
      }
    }

    for (const name of ["range", "if-range"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    headers.set("accept", request.headers.get("accept") || "*/*");
    headers.set("accept-encoding", "identity");
    return headers;
  }

  async remoteResponse(videoId, descriptor, request, mayRetry = true) {
    const response = await net.fetch(descriptor.url, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: this.buildUpstreamHeaders(descriptor, request),
      redirect: "follow",
      signal: request.signal,
      bypassCustomProtocolHandlers: true,
    });

    if (mayRetry && RETRYABLE_STATUS.has(response.status)) {
      this.invalidate(videoId);
      const refreshed = await this.resolveVideo(videoId, true);
      return this.remoteResponse(videoId, refreshed, request, false);
    }

    return response;
  }

  async handle(request) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errorResponse(405, "只支持 GET 与 HEAD");
      }

      const { host, pathname } = new URL(request.url);
      if (host !== "stream" && host !== "poster") {
        return errorResponse(404, "未知媒体类型");
      }

      const videoId = decodeURIComponent(pathname.replace(/^\/+/, ""));
      if (!videoId || videoId.includes("/")) {
        return errorResponse(400, "无效的视频 ID");
      }

      const entry = this.entries.get(videoId);
      const descriptor =
        host === "poster" ? entry?.poster : await this.resolveVideo(videoId);

      if (!descriptor) return errorResponse(404, "媒体资源不存在");
      if (descriptor.localPath) {
        return this.localFileResponse(descriptor.localPath, request);
      }

      return this.remoteResponse(
        videoId,
        descriptor,
        request,
        host === "stream",
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        return errorResponse(499, "媒体请求已取消");
      }

      console.error("[media-transport]", error);
      return errorResponse(502, error?.message || "媒体传输失败");
    }
  }
}

module.exports = { MediaTransport, parseRange };
