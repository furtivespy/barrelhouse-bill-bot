import path from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { ensureDataDir } from "./dataDir.js";

const DROP_STATUSES = Object.freeze(["open", "closed", "canceled"]);
const SIGNUP_STATUSES = Object.freeze(["allocated", "waitlist", "removed"]);
const PICKUP_STATUSES = Object.freeze(["pending", "pickedUp", "noShow"]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS drops (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    bottle_name TEXT NOT NULL,
    price TEXT,
    location TEXT,
    bottle_limit INTEGER,
    close_time TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'canceled')),
    created_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signups (
    drop_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('allocated', 'waitlist', 'removed')),
    pickup_status TEXT NOT NULL CHECK (pickup_status IN ('pending', 'pickedUp', 'noShow')),
    removed_by TEXT,
    removed_at TEXT,
    PRIMARY KEY (drop_id, user_id),
    FOREIGN KEY (drop_id) REFERENCES drops(id)
  );

  CREATE INDEX IF NOT EXISTS signups_drop_joined_at ON signups (drop_id, joined_at);
  CREATE INDEX IF NOT EXISTS drops_guild_status ON drops (guild_id, status);
`;

class DropError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

class DropNotFoundError extends DropError {}
class SignupNotFoundError extends DropError {}
class DuplicateSignupError extends DropError {}
class DropValidationError extends DropError {}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value, field) {
  if (value == null) {
    throw new DropValidationError(`${field} is required`);
  }
  const text = String(value).trim();
  if (!text) {
    throw new DropValidationError(`${field} is required`);
  }
  return text;
}

function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function optionalBottleLimit(value) {
  if (value == null || value === "") return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DropValidationError("bottleLimit must be a positive integer or omitted");
  }
  return limit;
}

function optionalTimestamp(value, field) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DropValidationError(`${field} must be a valid date`);
    }
    return value.toISOString();
  }
  const text = String(value).trim();
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new DropValidationError(`${field} must be a valid date`);
  }
  return parsed.toISOString();
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new DropValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function sqliteConstraintKind(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (code.includes("CONSTRAINT_PRIMARYKEY") || /unique|PRIMARY KEY/i.test(message)) {
    return "unique";
  }
  if (code.includes("CONSTRAINT_FOREIGNKEY") || /FOREIGN KEY/i.test(message)) {
    return "foreign";
  }
  if (code.includes("CONSTRAINT")) {
    return "constraint";
  }
  return null;
}

function mapDrop(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id ?? null,
    bottleName: row.bottle_name,
    price: row.price ?? null,
    location: row.location ?? null,
    bottleLimit: row.bottle_limit ?? null,
    closeTime: row.close_time ?? null,
    status: row.status,
    createdBy: row.created_by,
  };
}

function mapSignup(row) {
  if (!row) return undefined;
  return {
    dropId: row.drop_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
    status: row.status,
    pickupStatus: row.pickup_status,
    removedBy: row.removed_by ?? null,
    removedAt: row.removed_at ?? null,
  };
}

class DropStore {
  constructor(options = {}) {
    this.name = options.name || "drops";

    if (options.database) {
      this.db = options.database;
    } else if (options.filename === ":memory:") {
      this.db = new Database(":memory:");
    } else {
      const dataDir = options.dataDir || ensureDataDir();
      const filename = options.filename || `${this.name}.sqlite`;
      this.db = new Database(path.join(dataDir, filename), { create: true });
    }

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  createDrop(input = {}) {
    if (!isPlainObject(input)) {
      throw new DropValidationError("drop fields must be an object");
    }

    const drop = {
      id: optionalText(input.id) || randomUUID(),
      guildId: requiredText(input.guildId, "guildId"),
      channelId: requiredText(input.channelId, "channelId"),
      messageId: optionalText(input.messageId),
      bottleName: requiredText(input.bottleName, "bottleName"),
      price: optionalText(input.price),
      location: optionalText(input.location),
      bottleLimit: optionalBottleLimit(input.bottleLimit),
      closeTime: optionalTimestamp(input.closeTime, "closeTime"),
      status: oneOf(input.status ?? "open", DROP_STATUSES, "status"),
      createdBy: requiredText(input.createdBy, "createdBy"),
    };

    try {
      this.db
        .query(
          `INSERT INTO drops (
            id, guild_id, channel_id, message_id, bottle_name, price, location,
            bottle_limit, close_time, status, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          drop.id,
          drop.guildId,
          drop.channelId,
          drop.messageId,
          drop.bottleName,
          drop.price,
          drop.location,
          drop.bottleLimit,
          drop.closeTime,
          drop.status,
          drop.createdBy
        );
    } catch (error) {
      if (sqliteConstraintKind(error) === "unique") {
        throw new DropValidationError(`drop id already exists: ${drop.id}`, { cause: error });
      }
      throw error;
    }

    return this.getDrop(drop.id);
  }

  getDrop(id) {
    const dropId = requiredText(id, "id");
    return mapDrop(this.db.query("SELECT * FROM drops WHERE id = ?").get(dropId));
  }

  updateDrop(id, patch = {}) {
    const existing = this.getDrop(id);
    if (!existing) {
      throw new DropNotFoundError(`drop not found: ${id}`);
    }
    if (!isPlainObject(patch)) {
      throw new DropValidationError("drop update must be an object");
    }

    const next = {
      ...existing,
      guildId: patch.guildId !== undefined ? requiredText(patch.guildId, "guildId") : existing.guildId,
      channelId:
        patch.channelId !== undefined ? requiredText(patch.channelId, "channelId") : existing.channelId,
      messageId: patch.messageId !== undefined ? optionalText(patch.messageId) : existing.messageId,
      bottleName:
        patch.bottleName !== undefined ? requiredText(patch.bottleName, "bottleName") : existing.bottleName,
      price: patch.price !== undefined ? optionalText(patch.price) : existing.price,
      location: patch.location !== undefined ? optionalText(patch.location) : existing.location,
      bottleLimit:
        patch.bottleLimit !== undefined ? optionalBottleLimit(patch.bottleLimit) : existing.bottleLimit,
      closeTime:
        patch.closeTime !== undefined ? optionalTimestamp(patch.closeTime, "closeTime") : existing.closeTime,
      status: patch.status !== undefined ? oneOf(patch.status, DROP_STATUSES, "status") : existing.status,
      createdBy:
        patch.createdBy !== undefined ? requiredText(patch.createdBy, "createdBy") : existing.createdBy,
    };

    this.db
      .query(
        `UPDATE drops SET
          guild_id = ?, channel_id = ?, message_id = ?, bottle_name = ?, price = ?,
          location = ?, bottle_limit = ?, close_time = ?, status = ?, created_by = ?
        WHERE id = ?`
      )
      .run(
        next.guildId,
        next.channelId,
        next.messageId,
        next.bottleName,
        next.price,
        next.location,
        next.bottleLimit,
        next.closeTime,
        next.status,
        next.createdBy,
        existing.id
      );

    return this.getDrop(existing.id);
  }

  listDrops({ guildId, status } = {}) {
    const clauses = [];
    const params = [];
    if (guildId != null && guildId !== "") {
      clauses.push("guild_id = ?");
      params.push(String(guildId));
    }
    if (status != null && status !== "") {
      oneOf(status, DROP_STATUSES, "status");
      clauses.push("status = ?");
      params.push(status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.query(`SELECT * FROM drops ${where}`).all(...params);
    return rows.map(mapDrop);
  }

  createSignup(input = {}) {
    if (!isPlainObject(input)) {
      throw new DropValidationError("signup fields must be an object");
    }

    const signup = {
      dropId: requiredText(input.dropId, "dropId"),
      userId: requiredText(input.userId, "userId"),
      joinedAt: optionalTimestamp(input.joinedAt, "joinedAt") || new Date().toISOString(),
      status: oneOf(input.status, SIGNUP_STATUSES, "status"),
      pickupStatus: oneOf(input.pickupStatus ?? "pending", PICKUP_STATUSES, "pickupStatus"),
      removedBy: optionalText(input.removedBy),
      removedAt: optionalTimestamp(input.removedAt, "removedAt"),
    };

    if (!this.getDrop(signup.dropId)) {
      throw new DropNotFoundError(`drop not found: ${signup.dropId}`);
    }

    try {
      this.db
        .query(
          `INSERT INTO signups (
            drop_id, user_id, joined_at, status, pickup_status, removed_by, removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          signup.dropId,
          signup.userId,
          signup.joinedAt,
          signup.status,
          signup.pickupStatus,
          signup.removedBy,
          signup.removedAt
        );
    } catch (error) {
      if (sqliteConstraintKind(error) === "unique") {
        throw new DuplicateSignupError(
          `user ${signup.userId} is already signed up for drop ${signup.dropId}`,
          { cause: error }
        );
      }
      throw error;
    }

    return this.getSignup(signup.dropId, signup.userId);
  }

  getSignup(dropId, userId) {
    const resolvedDropId = requiredText(dropId, "dropId");
    const resolvedUserId = requiredText(userId, "userId");
    return mapSignup(
      this.db
        .query("SELECT * FROM signups WHERE drop_id = ? AND user_id = ?")
        .get(resolvedDropId, resolvedUserId)
    );
  }

  updateSignup(dropId, userId, patch = {}) {
    const existing = this.getSignup(dropId, userId);
    if (!existing) {
      throw new SignupNotFoundError(`signup not found: ${dropId}/${userId}`);
    }
    if (!isPlainObject(patch)) {
      throw new DropValidationError("signup update must be an object");
    }

    const next = {
      ...existing,
      status: patch.status !== undefined ? oneOf(patch.status, SIGNUP_STATUSES, "status") : existing.status,
      pickupStatus:
        patch.pickupStatus !== undefined
          ? oneOf(patch.pickupStatus, PICKUP_STATUSES, "pickupStatus")
          : existing.pickupStatus,
      removedBy: patch.removedBy !== undefined ? optionalText(patch.removedBy) : existing.removedBy,
      removedAt:
        patch.removedAt !== undefined ? optionalTimestamp(patch.removedAt, "removedAt") : existing.removedAt,
    };

    this.db
      .query(
        `UPDATE signups SET
          status = ?, pickup_status = ?, removed_by = ?, removed_at = ?
        WHERE drop_id = ? AND user_id = ?`
      )
      .run(next.status, next.pickupStatus, next.removedBy, next.removedAt, existing.dropId, existing.userId);

    return this.getSignup(existing.dropId, existing.userId);
  }

  listSignups(dropId, { status } = {}) {
    const resolvedDropId = requiredText(dropId, "dropId");
    const clauses = ["drop_id = ?"];
    const params = [resolvedDropId];
    if (status != null && status !== "") {
      oneOf(status, SIGNUP_STATUSES, "status");
      clauses.push("status = ?");
      params.push(status);
    }

    const rows = this.db
      .query(`SELECT * FROM signups WHERE ${clauses.join(" AND ")} ORDER BY joined_at ASC`)
      .all(...params);
    return rows.map(mapSignup);
  }

  close() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      console.error(`WAL checkpoint failed for ${this.name}:`, error);
    }
    this.db.close();
  }
}

export {
  DROP_STATUSES,
  SIGNUP_STATUSES,
  PICKUP_STATUSES,
  DropError,
  DropNotFoundError,
  SignupNotFoundError,
  DuplicateSignupError,
  DropValidationError,
};

export default DropStore;
