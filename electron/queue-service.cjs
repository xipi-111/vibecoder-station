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
    streamUrl: `vibecoder-media://stream/${encodeURIComponent(item.id)}`,
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
    const item = await this.resolverClient.next(afterId);
    if (!item?.id) throw new Error("队列接口没有返回 id");

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
