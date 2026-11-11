import { DropAlreadySettledError, DropNotFoundError } from "../db/drops.js";
import { buildStoredDropMessage, editDropPost, isDropOpen } from "./dropPost.js";

// Node/Bun timers use a 32-bit signed delay. Close times further out re-arm.
const MAX_TIMEOUT_MS = 2_147_483_647;
const POST_RETRY_MS = 5_000;
const RESCHEDULE_RETRY_MS = 15_000;
const MAX_POST_RETRIES = 5;

class DropCloser {
  constructor(client, options = {}) {
    this.client = client;
    this.now = options.now || (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    this.postRetryMs = options.postRetryMs ?? POST_RETRY_MS;
    this.rescheduleRetryMs = options.rescheduleRetryMs ?? RESCHEDULE_RETRY_MS;
    this.maxPostRetries = options.maxPostRetries ?? MAX_POST_RETRIES;
    this.timers = new Map();
    this.postRetries = new Map();
    this.rescheduleRetryHandle = null;
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
    for (const retry of this.postRetries.values()) {
      if (retry?.handle != null) this.clearTimeoutFn(retry.handle);
    }
    this.postRetries.clear();
    if (this.rescheduleRetryHandle != null) {
      this.clearTimeoutFn(this.rescheduleRetryHandle);
      this.rescheduleRetryHandle = null;
    }
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

  armRescheduleRetry() {
    if (this.rescheduleRetryHandle != null) return;
    this.rescheduleRetryHandle = this.setTimeoutFn(() => {
      this.rescheduleRetryHandle = null;
      return this.reschedulePending().catch((error) => {
        this.client?.logger?.error(error, "drop closer reschedule retry");
      });
    }, this.rescheduleRetryMs);
  }

  armPostRetry(dropId) {
    if (!dropId) return;
    const existing = this.postRetries.get(dropId);
    const attempts = (existing?.attempts || 0) + 1;
    if (attempts > this.maxPostRetries) return;
    if (existing?.handle != null) this.clearTimeoutFn(existing.handle);
    const handle = this.setTimeoutFn(async () => {
      const retry = this.postRetries.get(dropId);
      if (retry) retry.handle = null;
      const drop = this.client?.drops?.getDrop?.(dropId);
      if (!drop || isDropOpen(drop)) {
        this.postRetries.delete(dropId);
        return;
      }
      const posted = await this.syncClosedPost(drop);
      if (posted.retry) {
        this.armPostRetry(dropId);
        return;
      }
      this.postRetries.delete(dropId);
    }, this.postRetryMs);
    this.postRetries.set(dropId, { handle, attempts });
  }

  async reschedulePending() {
    const store = this.client?.drops;
    let drops;
    try {
      drops = typeof store?.listPendingCloses === "function" ? store.listPendingCloses() : [];
    } catch (error) {
      this.client?.logger?.error(error, "drop closer list pending");
      this.armRescheduleRetry();
      throw error;
    }

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
    const current = typeof store?.getDrop === "function" ? store.getDrop(drop.id) || drop : drop;
    try {
      const edited = await editDropPost(this.client, current, buildStoredDropMessage(store, current));
      if (!edited) {
        this.client?.logger?.error(
          new Error("no message.edit path for drop auto-close"),
          "drop auto-close post"
        );
        return { ok: false, retry: false };
      }
      return { ok: true, retry: false };
    } catch (error) {
      this.client?.logger?.error(error, "drop auto-close post");
      return { ok: false, retry: true };
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
      if (error instanceof DropNotFoundError) {
        return;
      }
      if (error instanceof DropAlreadySettledError) {
        const drop = typeof store.getDrop === "function" ? store.getDrop(dropId) : null;
        if (!drop) return;
        const posted = await this.syncClosedPost(drop);
        if (posted.retry) this.armPostRetry(dropId);
        return { drop, alreadySettled: true, postUpdated: posted.ok };
      }
      this.client?.logger?.error(error, "drop auto-close");
      return;
    }

    const posted = await this.syncClosedPost(result.drop);
    if (posted.retry) this.armPostRetry(dropId);
    return { ...result, postUpdated: posted.ok };
  }
}

export { MAX_TIMEOUT_MS, POST_RETRY_MS, RESCHEDULE_RETRY_MS, MAX_POST_RETRIES, DropCloser };
export default DropCloser;
