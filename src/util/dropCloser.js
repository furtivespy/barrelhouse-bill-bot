import { DropAlreadySettledError, DropNotFoundError } from "../db/drops.js";
import { buildStoredDropMessage, editDropPost } from "./dropPost.js";

// Node/Bun timers use a 32-bit signed delay. Close times further out re-arm.
const MAX_TIMEOUT_MS = 2_147_483_647;

class DropCloser {
  constructor(client, options = {}) {
    this.client = client;
    this.now = options.now || (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    this.timers = new Map();
  }

  unschedule(dropId) {
    if (!dropId) return;
    const handle = this.timers.get(dropId);
    if (handle == null) return;
    this.clearTimeoutFn(handle);
    this.timers.delete(dropId);
  }

  stop() {
    for (const handle of this.timers.values()) {
      this.clearTimeoutFn(handle);
    }
    this.timers.clear();
  }

  msUntilClose(drop) {
    if (!drop?.closeTime) return null;
    const remaining = new Date(drop.closeTime).getTime() - this.now();
    return Number.isFinite(remaining) ? remaining : null;
  }

  schedule(drop) {
    if (!drop?.id) return;
    this.unschedule(drop.id);
    if (drop.status !== "open" || !drop.closeTime) {
      return;
    }

    const remaining = this.msUntilClose(drop);
    if (remaining == null) {
      this.client?.logger?.error(
        new Error(`invalid close time on drop ${drop.id}`),
        "drop auto-close"
      );
      return;
    }
    if (remaining <= 0) {
      return this.closeDueDrop(drop.id);
    }

    const wait = Math.min(remaining, MAX_TIMEOUT_MS);
    const handle = this.setTimeoutFn(() => {
      this.timers.delete(drop.id);
      const current = this.client?.drops?.getDrop?.(drop.id);
      if (!current) return;
      return this.schedule(current);
    }, wait);
    this.timers.set(drop.id, handle);
  }

  async reschedulePending() {
    const store = this.client?.drops;
    const drops = typeof store?.listPendingCloses === "function" ? store.listPendingCloses() : [];
    for (const drop of drops) {
      const remaining = this.msUntilClose(drop);
      if (remaining == null) {
        this.client?.logger?.error(
          new Error(`invalid close time on drop ${drop.id}`),
          "drop auto-close"
        );
        continue;
      }
      if (remaining <= 0) {
        await this.closeDueDrop(drop.id);
      } else {
        this.schedule(drop);
      }
    }
    return drops.length;
  }

  async syncClosedPost(drop) {
    const store = this.client?.drops;
    try {
      const edited = await editDropPost(this.client, drop, buildStoredDropMessage(store, drop));
      if (!edited) {
        this.client?.logger?.error(
          new Error("no message.edit path for drop auto-close"),
          "drop auto-close post"
        );
      }
      return Boolean(edited);
    } catch (error) {
      this.client?.logger?.error(error, "drop auto-close post");
      return false;
    }
  }

  async closeDueDrop(dropId) {
    this.unschedule(dropId);
    const store = this.client?.drops;
    if (!store || typeof store.setDropStatus !== "function") {
      return;
    }

    let result;
    try {
      result = store.setDropStatus(dropId, "closed");
    } catch (error) {
      if (error instanceof DropAlreadySettledError || error instanceof DropNotFoundError) {
        return;
      }
      this.client?.logger?.error(error, "drop auto-close");
      return;
    }

    await this.syncClosedPost(result.drop);
    return result;
  }
}

export { MAX_TIMEOUT_MS, DropCloser };
export default DropCloser;
