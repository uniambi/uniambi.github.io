/** Two-entry cache of complete video blobs: works with Python's plain HTTP server. */
export class VideoCache {
  constructor(limit = 2) { this.limit = limit; this.entries = new Map(); this.pending = null; }

  async get(url) {
    if (this.pending && this.pending.url !== url) this.cancelPending();
    if (this.entries.has(url)) {
      const entry = this.entries.get(url);
      this.entries.delete(url); this.entries.set(url, entry);
      return entry;
    }
    if (this.pending?.url === url) return this.pending.promise;
    const controller = new AbortController();
    const request = {url, controller, promise:null};
    request.promise = (async () => {
      const response = await fetch(url, {signal:controller.signal});
      if (!response.ok) throw new Error(`Video could not be loaded (HTTP ${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (controller.signal.aborted) throw new DOMException('Video loading cancelled.', 'AbortError');
      // The caller detaches the previous video before requesting a different source.
      // Evict before creating a blob, so even the transient URL count is <= limit.
      while (this.entries.size >= this.limit) {
        const oldest = this.entries.keys().next().value;
        URL.revokeObjectURL(this.entries.get(oldest)); this.entries.delete(oldest);
      }
      const objectURL = URL.createObjectURL(new Blob([bytes], {type:'video/mp4'}));
      this.entries.set(url, objectURL);
      return objectURL;
    })();
    this.pending = request;
    try { return await request.promise; }
    finally { if (this.pending === request) this.pending = null; }
  }

  cancelPending() { this.pending?.controller.abort(); this.pending = null; }
  clear() {
    this.cancelPending();
    for (const objectURL of this.entries.values()) URL.revokeObjectURL(objectURL);
    this.entries.clear();
  }
}
