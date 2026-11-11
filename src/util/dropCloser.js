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

  schedule(drop) {
    if (!drop?.id) return;
    this.unschedule(drop.id);
    if (drop.status !== "open" || !drop.closeTime) {
      return;
    }

    const remaining = new Date(drop.closeTime).getTime() - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
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
    const due = [];
    for (const drop of drops) {
      const remaining = new Date(drop.closeTime).getTime() - this.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        due.push(this.closeDueDrop(drop.id));
      } else {
        this.schedule(drop);
      }
    }
    await Promise.allSettled(due);
    return drops.length;
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
    if (result.alreadySettled) {
      return result;
    }

    try {
      await editDropPost(this.client, result.drop, buildStoredDropMessage(store, result.drop));
    } catch (error) {
      this.client?.logger?.error(error, "drop auto-close post");
    }
    return result;
  }
}

export { MAX_TIMEOUT_MS, DropCloser };
export default DropCloser;
