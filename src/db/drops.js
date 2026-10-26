import path from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { ensureDataDir } from "./dataDir.js";

const SCHEMA_VERSION = 1;
const DROP_STATUSES = Object.freeze(["open", "closed", "canceled"]);
const SIGNUP_STATUSES = Object.freeze(["allocated", "waitlist", "removed"]);
const PICKUP_STATUSES = Object.freeze(["pending", "picked_up", "no_show"]);
const BUSY_TIMEOUT_MS = 10_000;

const DROPS_COLUMNS = `
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    bottle_name TEXT NOT NULL,
    description TEXT,
    price TEXT,
    location TEXT,
    bottle_limit INTEGER,
    close_time TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'canceled')),
    created_by TEXT NOT NULL
`;

const SIGNUPS_COLUMNS = `
    drop_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('allocated', 'waitlist', 'removed')),
    pickup_status TEXT NOT NULL CHECK (pickup_status IN ('pending', 'picked_up', 'no_show')),
    removed_by TEXT,
    removed_at TEXT,
    PRIMARY KEY (drop_id, user_id),
    FOREIGN KEY (drop_id) REFERENCES drops(id)
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS drops (${DROPS_COLUMNS});
  CREATE TABLE IF NOT EXISTS signups (${SIGNUPS_COLUMNS});
  CREATE INDEX IF NOT EXISTS signups_drop_joined_at ON signups (drop_id, joined_at);
  CREATE INDEX IF NOT EXISTS drops_guild_status ON drops (guild_id, status);
`;

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

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
class DropNotOpenError extends DropValidationError {
  constructor(status, options) {
    super(`cannot sign up for a ${status} drop`, options);
    this.dropStatus = status;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value, field) {
  if (value == null) {
    throw new DropValidationError(`${field} is required`);
  }
  if (typeof value !== "string") {
    throw new DropValidationError(`${field} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    throw new DropValidationError(`${field} is required`);
  }
  return text;
}

function optionalText(value, field) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new DropValidationError(`${field} must be a string`);
  }
  const text = value.trim();
  return text === "" ? null : text;
}

function optionalBottleLimit(value, field = "bottleLimit") {
  const message = `${field} must be a positive integer or omitted`;
  if (value == null || value === "") return null;
  if (typeof value === "boolean") {
    throw new DropValidationError(message);
  }

  let limit;
  if (typeof value === "number") {
    limit = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!/^[1-9]\d*$/.test(text)) {
      throw new DropValidationError(message);
    }
    limit = Number(text);
  } else {
    throw new DropValidationError(message);
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new DropValidationError(message);
  }
  return limit;
}

function optionalTimestamp(value, field) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean" || typeof value === "number") {
    throw new DropValidationError(`${field} must be a valid date`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DropValidationError(`${field} must be a valid date`);
    }
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new DropValidationError(`${field} must be a valid date`);
  }
  const text = value.trim();
  if (!ISO_TIMESTAMP.test(text)) {
    throw new DropValidationError(`${field} must be a valid date`);
  }
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
  if (
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    /UNIQUE constraint failed/i.test(message)
  ) {
    return "unique";
  }
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY constraint failed/i.test(message)) {
    return "foreign";
  }
  if (code === "SQLITE_CONSTRAINT_CHECK" || /CHECK constraint failed/i.test(message)) {
    return "check";
  }
  if (code.includes("CONSTRAINT")) {
    return "constraint";
  }
  return null;
}

function userVersion(db) {
  return db.query("PRAGMA user_version").get().user_version;
}

function setUserVersion(db, version) {
  const n = Number(version);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid schema version: ${version}`);
  }
  db.exec(`PRAGMA user_version = ${n}`);
}

function tableSql(db, name) {
  return db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql ?? "";
}

function tableColumns(db, table) {
  return db.query(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function rebuildSignupsTable(db) {
  db.exec(`
    CREATE TABLE signups_migrate (${SIGNUPS_COLUMNS});
    INSERT INTO signups_migrate (
      drop_id, user_id, joined_at, status, pickup_status, removed_by, removed_at
    )
    SELECT
      drop_id,
      user_id,
      joined_at,
      status,
      CASE pickup_status
        WHEN 'pickedUp' THEN 'picked_up'
        WHEN 'noShow' THEN 'no_show'
        ELSE pickup_status
      END,
      removed_by,
      removed_at
    FROM signups;
    DROP TABLE signups;
    ALTER TABLE signups_migrate RENAME TO signups;
    CREATE INDEX IF NOT EXISTS signups_drop_joined_at ON signups (drop_id, joined_at);
  `);
}

function migrateSchema(db) {
  db.exec(SCHEMA);

  const version = userVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `drops.sqlite user_version ${version} is newer than supported schema version ${SCHEMA_VERSION}`
    );
  }

  if (version < 1) {
    db.transaction(() => {
      ensureColumn(db, "drops", "description", "TEXT");
      const signupSql = tableSql(db, "signups");
      if (/pickedUp|noShow/.test(signupSql)) {
        rebuildSignupsTable(db);
      }
      setUserVersion(db, 1);
    })();
  }
}

function normalizeSignupRemoval(signup) {
  if (signup.status === "removed") {
    if (!signup.removedBy) {
      throw new DropValidationError("removedBy is required when status is removed");
    }
    signup.removedAt = signup.removedAt || new Date().toISOString();
    return signup;
  }
  signup.removedBy = null;
  signup.removedAt = null;
  return signup;
}

function mapDrop(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id ?? null,
    bottleName: row.bottle_name,
    description: row.description ?? null,
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

function runImmediate(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN may have failed, or SQLite already rolled back.
    }
    throw error;
  }
}

function signupPosition(signups, userId) {
  const signup = signups.find((row) => row.userId === userId);
  if (!signup || signup.status === "removed") {
    return null;
  }
  const peers = signups.filter((row) => row.status === signup.status);
  const index = peers.findIndex((row) => row.userId === userId);
  return index === -1 ? null : index + 1;
}

function countSignups(signups = []) {
  let allocated = 0;
  let waitlisted = 0;
  for (const signup of signups) {
    if (signup?.status === "allocated") allocated += 1;
    if (signup?.status === "waitlist") waitlisted += 1;
  }
  return { allocated, waitlisted };
}

function signupCountsFromRows(signups, bottleLimit) {
  return {
    ...countSignups(signups),
    bottleLimit: bottleLimit ?? null,
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
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    migrateSchema(this.db);
  }

  createDrop(input = {}) {
    if (!isPlainObject(input)) {
      throw new DropValidationError("drop fields must be an object");
    }

    const drop = {
      id: optionalText(input.id, "id") || randomUUID(),
      guildId: requiredText(input.guildId, "guildId"),
      channelId: requiredText(input.channelId, "channelId"),
      messageId: optionalText(input.messageId, "messageId"),
      bottleName: requiredText(input.bottleName, "bottleName"),
      description: optionalText(input.description, "description"),
      price: optionalText(input.price, "price"),
      location: optionalText(input.location, "location"),
      bottleLimit: optionalBottleLimit(input.bottleLimit),
      closeTime: optionalTimestamp(input.closeTime, "closeTime"),
      status: oneOf(input.status ?? "open", DROP_STATUSES, "status"),
      createdBy: requiredText(input.createdBy, "createdBy"),
    };

    try {
      this.db
        .query(
          `INSERT INTO drops (
            id, guild_id, channel_id, message_id, bottle_name, description, price, location,
            bottle_limit, close_time, status, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          drop.id,
          drop.guildId,
          drop.channelId,
          drop.messageId,
          drop.bottleName,
          drop.description,
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
      messageId:
        patch.messageId !== undefined ? optionalText(patch.messageId, "messageId") : existing.messageId,
      bottleName:
        patch.bottleName !== undefined ? requiredText(patch.bottleName, "bottleName") : existing.bottleName,
      description:
        patch.description !== undefined
          ? optionalText(patch.description, "description")
          : existing.description,
      price: patch.price !== undefined ? optionalText(patch.price, "price") : existing.price,
      location: patch.location !== undefined ? optionalText(patch.location, "location") : existing.location,
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
          guild_id = ?, channel_id = ?, message_id = ?, bottle_name = ?, description = ?, price = ?,
          location = ?, bottle_limit = ?, close_time = ?, status = ?, created_by = ?
        WHERE id = ?`
      )
      .run(
        next.guildId,
        next.channelId,
        next.messageId,
        next.bottleName,
        next.description,
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

  listDrops({ guildId, channelId, status } = {}) {
    const clauses = [];
    const params = [];
    if (guildId != null && guildId !== "") {
      if (typeof guildId !== "string") {
        throw new DropValidationError("guildId must be a string");
      }
      const resolved = guildId.trim();
      if (resolved) {
        clauses.push("guild_id = ?");
        params.push(resolved);
      }
    }
    if (channelId != null && channelId !== "") {
      if (typeof channelId !== "string") {
        throw new DropValidationError("channelId must be a string");
      }
      const resolved = channelId.trim();
      if (resolved) {
        clauses.push("channel_id = ?");
        params.push(resolved);
      }
    }
    if (status != null && status !== "") {
      oneOf(status, DROP_STATUSES, "status");
      clauses.push("status = ?");
      params.push(status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM drops ${where} ORDER BY rowid DESC`)
      .all(...params);
    return rows.map(mapDrop);
  }

  allocatedCount(dropId) {
    return Number(
      this.db
        .query(`SELECT COUNT(*) AS n FROM signups WHERE drop_id = ? AND status = 'allocated'`)
        .get(dropId).n
    );
  }

  hasAllocationRoom(drop) {
    return drop.bottleLimit == null || this.allocatedCount(drop.id) < drop.bottleLimit;
  }

  // Assumes the caller already holds a write transaction (BEGIN IMMEDIATE).
  promoteNextWaitlisted(drop) {
    if (!this.hasAllocationRoom(drop)) {
      return null;
    }
    const next = this.listSignups(drop.id, { status: "waitlist" })[0];
    if (!next) {
      return null;
    }
    return this.updateSignup(drop.id, next.userId, { status: "allocated" });
  }

  removeSignup(dropId, userId, options = {}) {
    const resolvedDropId = requiredText(dropId, "dropId");
    const resolvedUserId = requiredText(userId, "userId");
    if (!isPlainObject(options)) {
      throw new DropValidationError("remove options must be an object");
    }
    const removedBy = requiredText(options.removedBy, "removedBy");
    const removedAt =
      options.removedAt !== undefined
        ? optionalTimestamp(options.removedAt, "removedAt")
        : null;

    return runImmediate(this.db, () => {
      const drop = this.getDrop(resolvedDropId);
      if (!drop) {
        throw new DropNotFoundError(`drop not found: ${resolvedDropId}`);
      }

      const existing = this.getSignup(drop.id, resolvedUserId);
      if (!existing) {
        throw new SignupNotFoundError(`signup not found: ${drop.id}/${resolvedUserId}`);
      }
      if (existing.status === "removed") {
        return {
          drop,
          signup: existing,
          alreadyRemoved: true,
          promoted: null,
          counts: signupCountsFromRows(this.listSignups(drop.id), drop.bottleLimit),
        };
      }

      const hadBottle = existing.status === "allocated";
      const signup = this.updateSignup(drop.id, resolvedUserId, {
        status: "removed",
        removedBy,
        removedAt: removedAt || new Date().toISOString(),
      });
      const promoted = hadBottle ? this.promoteNextWaitlisted(drop) : null;

      return {
        drop,
        signup,
        alreadyRemoved: false,
        promoted,
        counts: signupCountsFromRows(this.listSignups(drop.id), drop.bottleLimit),
      };
    });
  }

  setPickupStatus(dropId, userId, pickupStatus) {
    const resolvedDropId = requiredText(dropId, "dropId");
    const resolvedUserId = requiredText(userId, "userId");
    const resolvedPickup = oneOf(pickupStatus, PICKUP_STATUSES, "pickupStatus");

    return runImmediate(this.db, () => {
      const drop = this.getDrop(resolvedDropId);
      if (!drop) {
        throw new DropNotFoundError(`drop not found: ${resolvedDropId}`);
      }

      const existing = this.getSignup(drop.id, resolvedUserId);
      if (!existing) {
        throw new SignupNotFoundError(`signup not found: ${drop.id}/${resolvedUserId}`);
      }
      if (existing.status !== "allocated") {
        throw new DropValidationError("only allocated sign-ups can be marked for pickup");
      }

      const signup = this.updateSignup(drop.id, resolvedUserId, { pickupStatus: resolvedPickup });
      return { drop, signup };
    });
  }

  insertSignupRecord(signup) {
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
      const kind = sqliteConstraintKind(error);
      if (kind === "unique") {
        throw new DuplicateSignupError(
          `user ${signup.userId} is already signed up for drop ${signup.dropId}`,
          { cause: error }
        );
      }
      if (kind === "foreign") {
        throw new DropNotFoundError(`drop not found: ${signup.dropId}`, { cause: error });
      }
      throw error;
    }

    return this.getSignup(signup.dropId, signup.userId);
  }

  // Assumes the caller already holds a write transaction (BEGIN IMMEDIATE).
  rejoinRemovedSignup(drop, userId, joinedAt) {
    const status = this.hasAllocationRoom(drop) ? "allocated" : "waitlist";
    return this.updateSignup(drop.id, userId, {
      status,
      pickupStatus: "pending",
      joinedAt,
    });
  }

  joinOutcome(drop, signup, created) {
    const signups = this.listSignups(drop.id);
    return {
      drop,
      signup,
      created,
      position: signupPosition(signups, signup.userId),
      counts: signupCountsFromRows(signups, drop.bottleLimit),
    };
  }

  createSignup(input = {}) {
    if (!isPlainObject(input)) {
      throw new DropValidationError("signup fields must be an object");
    }

    const signup = normalizeSignupRemoval({
      dropId: requiredText(input.dropId, "dropId"),
      userId: requiredText(input.userId, "userId"),
      joinedAt: optionalTimestamp(input.joinedAt, "joinedAt") || new Date().toISOString(),
      status: oneOf(input.status, SIGNUP_STATUSES, "status"),
      pickupStatus: oneOf(input.pickupStatus ?? "pending", PICKUP_STATUSES, "pickupStatus"),
      removedBy: optionalText(input.removedBy, "removedBy"),
      removedAt: optionalTimestamp(input.removedAt, "removedAt"),
    });

    return this.db.transaction(() => {
      const drop = this.getDrop(signup.dropId);
      if (drop && drop.status !== "open") {
        throw new DropNotOpenError(drop.status);
      }

      return this.insertSignupRecord(signup);
    })();
  }

  joinSignup(dropId, userId, options = {}) {
    const resolvedDropId = requiredText(dropId, "dropId");
    const resolvedUserId = requiredText(userId, "userId");
    if (!isPlainObject(options)) {
      throw new DropValidationError("join options must be an object");
    }
    const joinedAt =
      options.joinedAt !== undefined ? optionalTimestamp(options.joinedAt, "joinedAt") : null;

    return runImmediate(this.db, () => {
      const drop = this.getDrop(resolvedDropId);
      if (!drop) {
        throw new DropNotFoundError(`drop not found: ${resolvedDropId}`);
      }
      if (drop.status !== "open") {
        throw new DropNotOpenError(drop.status);
      }

      const existing = this.getSignup(drop.id, resolvedUserId);
      if (existing && existing.status !== "removed") {
        return this.joinOutcome(drop, existing, false);
      }

      const at = joinedAt || new Date().toISOString();
      if (existing?.status === "removed") {
        return this.joinOutcome(drop, this.rejoinRemovedSignup(drop, resolvedUserId, at), true);
      }

      const status = this.hasAllocationRoom(drop) ? "allocated" : "waitlist";

      try {
        const signup = this.insertSignupRecord({
          dropId: drop.id,
          userId: resolvedUserId,
          joinedAt: at,
          status,
          pickupStatus: "pending",
          removedBy: null,
          removedAt: null,
        });
        return this.joinOutcome(drop, signup, true);
      } catch (error) {
        if (error instanceof DuplicateSignupError) {
          const raced = this.getSignup(drop.id, resolvedUserId);
          if (raced?.status === "removed") {
            return this.joinOutcome(drop, this.rejoinRemovedSignup(drop, resolvedUserId, at), true);
          }
          if (raced) {
            return this.joinOutcome(drop, raced, false);
          }
        }
        throw error;
      }
    });
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

    const next = normalizeSignupRemoval({
      ...existing,
      joinedAt:
        patch.joinedAt !== undefined
          ? optionalTimestamp(patch.joinedAt, "joinedAt") || existing.joinedAt
          : existing.joinedAt,
      status: patch.status !== undefined ? oneOf(patch.status, SIGNUP_STATUSES, "status") : existing.status,
      pickupStatus:
        patch.pickupStatus !== undefined
          ? oneOf(patch.pickupStatus, PICKUP_STATUSES, "pickupStatus")
          : existing.pickupStatus,
      removedBy: patch.removedBy !== undefined ? optionalText(patch.removedBy, "removedBy") : existing.removedBy,
      removedAt:
        patch.removedAt !== undefined ? optionalTimestamp(patch.removedAt, "removedAt") : existing.removedAt,
    });

    this.db
      .query(
        `UPDATE signups SET
          joined_at = ?, status = ?, pickup_status = ?, removed_by = ?, removed_at = ?
        WHERE drop_id = ? AND user_id = ?`
      )
      .run(
        next.joinedAt,
        next.status,
        next.pickupStatus,
        next.removedBy,
        next.removedAt,
        existing.dropId,
        existing.userId
      );

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
      .query(
        `SELECT * FROM signups WHERE ${clauses.join(" AND ")} ORDER BY joined_at ASC, rowid ASC`
      )
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
  SCHEMA_VERSION,
  DROP_STATUSES,
  SIGNUP_STATUSES,
  PICKUP_STATUSES,
  BUSY_TIMEOUT_MS,
  DropError,
  DropNotFoundError,
  SignupNotFoundError,
  DuplicateSignupError,
  DropValidationError,
  DropNotOpenError,
  requiredText,
  optionalText,
  optionalBottleLimit,
  optionalTimestamp,
  countSignups,
};

export default DropStore;
