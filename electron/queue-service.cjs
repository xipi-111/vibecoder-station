function publicItem(item) {
  return {
    id: item.id,
    pluginId: item.pluginId ?? null,
    authorId: item.authorId ?? null,
    publishedAt: item.publishedAt ?? null,
    priority: item.priority ?? "shuffle",
    kind: item.kind ?? "video",
    durationMs: item.durationMs ?? null,
    streamUrl: item.media
      ? `vibecoder-media://stream/${encodeURIComponent(item.id)}`
      : undefined,
    imageUrls: (item.imageMedia ?? []).map(
      (_image, index) =>
        `vibecoder-media://image/${encodeURIComponent(item.id)}/${index}`,
    ),
    posterUrl:
      item.posterUrl ??
      (item.posterMedia
        ? `vibecoder-media://poster/${encodeURIComponent(item.id)}`
        : undefined),
  };
}

class QueueService {
  constructor({ resolverClient, mediaTransport }) {
    this.resolverClient = resolverClient;
    this.mediaTransport = mediaTransport;
  }

  async fromResolver(afterId) {
    if (!this.resolverClient.enabled) {
      throw new Error("还没有安装内容源插件");
    }

    const queuedItem = await this.resolverClient.next(afterId);
    if (!queuedItem?.id) throw new Error("内容源插件没有返回作品 id");

    const resolvedItem =
      queuedItem.media &&
      (queuedItem.kind !== "image" || queuedItem.imageMedia?.length)
        ? queuedItem
        : {
            ...queuedItem,
            ...(await this.resolverClient.resolve(queuedItem.id)),
          };
    const item = { ...queuedItem, ...resolvedItem };
    this.mediaTransport.registerItem(item);
    return publicItem(item);
  }

  getInitial() {
    return this.fromResolver(null);
  }

  getNext(afterId) {
    return this.fromResolver(afterId);
  }
}

module.exports = { QueueService };
