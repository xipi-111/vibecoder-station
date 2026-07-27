const path = require("node:path");

const DEMO_ITEMS = [
  {
    id: "maker-workshop",
    mediaFile: "maker-workshop.mp4",
    posterFile: "maker-workshop.png",
    priority: "new",
    publishedAt: "2026-07-27T00:00:00.000Z",
  },
  {
    id: "indie-developer",
    mediaFile: "indie-developer.mp4",
    posterFile: "indie-developer.png",
    priority: "shuffle",
    publishedAt: "2026-07-24T00:00:00.000Z",
  },
  {
    id: "product-sketch",
    mediaFile: "product-sketch.mp4",
    posterFile: "product-sketch.png",
    priority: "shuffle",
    publishedAt: "2026-07-21T00:00:00.000Z",
  },
];

function publicItem(item) {
  return {
    id: item.id,
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
      (item.posterFile || item.posterMedia
        ? `vibecoder-media://poster/${encodeURIComponent(item.id)}`
        : undefined),
  };
}

class QueueService {
  constructor({ resolverClient, mediaTransport, mediaDirectory }) {
    this.resolverClient = resolverClient;
    this.mediaTransport = mediaTransport;
    this.mediaDirectory = mediaDirectory;
    this.demoIndex = -1;

    if (!this.resolverClient.enabled) {
      for (const item of DEMO_ITEMS) {
        this.mediaTransport.registerLocalItem({
          id: item.id,
          mediaPath: path.join(mediaDirectory, item.mediaFile),
          posterPath: path.join(mediaDirectory, item.posterFile),
        });
      }
    }
  }

  async fromResolver(afterId) {
    const queuedItem = await this.resolverClient.next(afterId);
    if (!queuedItem?.id) throw new Error("队列接口没有返回 id");

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

  fromDemo() {
    this.demoIndex = (this.demoIndex + 1) % DEMO_ITEMS.length;
    return publicItem(DEMO_ITEMS[this.demoIndex]);
  }

  getInitial() {
    return this.resolverClient.enabled
      ? this.fromResolver(null)
      : Promise.resolve(this.fromDemo());
  }

  getNext(afterId) {
    return this.resolverClient.enabled
      ? this.fromResolver(afterId)
      : Promise.resolve(this.fromDemo());
  }
}

module.exports = { QueueService };
