import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import DropStore, {
  SCHEMA_VERSION,
  DROP_STATUSES,
  SIGNUP_STATUSES,
  PICKUP_STATUSES,
  DuplicateSignupError,
  DropNotFoundError,
  DropValidationError,
  SignupNotFoundError,
} from "../src/db/drops.js";

function memoryDrops() {
  return new DropStore({ filename: ":memory:" });
}

function sampleDrop(overrides = {}) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    bottleName: "EH Taylor Small Batch",
    createdBy: "mod-1",
    ...overrides,
  };
}

function tableSql(db, name) {
  return db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).sql;
}

describe("drop store schema", () => {
  test("exposes the documented status enums", () => {
    expect(DROP_STATUSES).toEqual(["open", "closed", "canceled"]);
    expect(SIGNUP_STATUSES).toEqual(["allocated", "waitlist", "removed"]);
    expect(PICKUP_STATUSES).toEqual(["pending", "picked_up", "no_show"]);
  });

  test("writes a self-contained versioned schema with keys and CHECK constraints", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-drops-schema-"));
    try {
      const store = new DropStore({ dataDir });
      expect(store.db.query("PRAGMA user_version").get().user_version).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(1);

      const tables = store.db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(["drops", "signups"]));

      const dropSql = tableSql(store.db, "drops");
      expect(dropSql).toMatch(/id TEXT PRIMARY KEY/);
      expect(dropSql).toMatch(/description TEXT/);
      expect(dropSql).toMatch(/CHECK \(status IN \('open', 'closed', 'canceled'\)\)/);

      const signupSql = tableSql(store.db, "signups");
      expect(signupSql).toMatch(/PRIMARY KEY \(drop_id, user_id\)/);
      expect(signupSql).toMatch(/FOREIGN KEY \(drop_id\) REFERENCES drops\(id\)/);
      expect(signupSql).toMatch(/CHECK \(status IN \('allocated', 'waitlist', 'removed'\)\)/);
      expect(signupSql).toMatch(
        /CHECK \(pickup_status IN \('pending', 'picked_up', 'no_show'\)\)/
      );
      store.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("enforces drop and signup CHECK constraints at the database", () => {
    const store = memoryDrops();
    store.createDrop(sampleDrop({ id: "drop-1" }));

    let dropStatusError;
    try {
      store.db
        .query(
          `INSERT INTO drops (id, guild_id, channel_id, bottle_name, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run("drop-2", "guild-1", "channel-1", "Bottle", "pending", "mod-1");
    } catch (error) {
      dropStatusError = error;
    }
    expect(dropStatusError?.code).toBe("SQLITE_CONSTRAINT_CHECK");

    let signupStatusError;
    try {
      store.db
        .query(
          `INSERT INTO signups (
            drop_id, user_id, joined_at, status, pickup_status, removed_by, removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("drop-1", "user-1", "2026-10-24T12:00:00.000Z", "in", "pending", null, null);
    } catch (error) {
      signupStatusError = error;
    }
    expect(signupStatusError?.code).toBe("SQLITE_CONSTRAINT_CHECK");

    let pickupStatusError;
    try {
      store.db
        .query(
          `INSERT INTO signups (
            drop_id, user_id, joined_at, status, pickup_status, removed_by, removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("drop-1", "user-2", "2026-10-24T12:00:00.000Z", "allocated", "done", null, null);
    } catch (error) {
      pickupStatusError = error;
    }
    expect(pickupStatusError?.code).toBe("SQLITE_CONSTRAINT_CHECK");
    store.close();
  });
});

describe("drop helpers", () => {
  test("creates a drop with required fields and open status by default", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());

    expect(typeof drop.id).toBe("string");
    expect(drop.id.length).toBeGreaterThan(0);
    expect(drop).toMatchObject({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: null,
      bottleName: "EH Taylor Small Batch",
      description: null,
      price: null,
      location: null,
      bottleLimit: null,
      closeTime: null,
      status: "open",
      createdBy: "mod-1",
    });
    expect(store.getDrop(drop.id)).toEqual(drop);
    store.close();
  });

  test("stores optional description, price, location, limit, close time, and message id", () => {
    const store = memoryDrops();
    const closeTime = "2026-10-24T18:00:00.000Z";
    const drop = store.createDrop(
      sampleDrop({
        messageId: "msg-1",
        description: "Cherry, oak, and a little rye spice.",
        price: "$59.99",
        location: "Liquor Barn New Circle",
        bottleLimit: 12,
        closeTime,
      })
    );

    expect(drop).toMatchObject({
      messageId: "msg-1",
      description: "Cherry, oak, and a little rye spice.",
      price: "$59.99",
      location: "Liquor Barn New Circle",
      bottleLimit: 12,
      closeTime,
    });
    expect(store.updateDrop(drop.id, { description: "Updated tasting notes" }).description).toBe(
      "Updated tasting notes"
    );
    expect(store.updateDrop(drop.id, { description: "" }).description).toBeNull();
    store.close();
  });

  test("treats a missing bottle limit as unlimited and binds a set limit", () => {
    const store = memoryDrops();
    expect(store.createDrop(sampleDrop()).bottleLimit).toBeNull();
    const limited = store.createDrop(sampleDrop({ bottleLimit: 6 }));
    expect(limited.bottleLimit).toBe(6);
    expect(store.getDrop(limited.id).bottleLimit).toBe(6);
    expect(() => store.createDrop(sampleDrop({ bottleLimit: 0 }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ bottleLimit: -2 }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ bottleLimit: true }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ bottleLimit: "1e2" }))).toThrow(DropValidationError);
    store.close();
  });

  test("rejects missing required fields, invalid status, and non-string snowflakes", () => {
    const store = memoryDrops();
    expect(() => store.createDrop({})).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ bottleName: "  " }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ status: "pending" }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ guildId: false }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ channelId: 123 }))).toThrow(DropValidationError);
    store.close();
  });

  test("rejects non-ISO close times including true and 0-style values", () => {
    const store = memoryDrops();
    expect(() => store.createDrop(sampleDrop({ closeTime: true }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ closeTime: 0 }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ closeTime: "0" }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ closeTime: "2026" }))).toThrow(DropValidationError);
    expect(store.createDrop(sampleDrop({ closeTime: "2026-10-24T18:00:00.000Z" })).closeTime).toBe(
      "2026-10-24T18:00:00.000Z"
    );
    store.close();
  });

  test("updates drop fields including closed and canceled status", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    const closed = store.updateDrop(drop.id, {
      messageId: "msg-9",
      status: "closed",
    });
    expect(closed.messageId).toBe("msg-9");
    expect(closed.status).toBe("closed");
    expect(store.updateDrop(drop.id, { status: "canceled" }).status).toBe("canceled");
    expect(() => store.updateDrop("missing", { status: "closed" })).toThrow(DropNotFoundError);
    store.close();
  });

  test("lists drops by guild and status and trims guild ids", () => {
    const store = memoryDrops();
    const openA = store.createDrop(sampleDrop({ bottleName: "A" }));
    store.createDrop(sampleDrop({ guildId: "guild-2", bottleName: "B" }));
    store.createDrop(sampleDrop({ bottleName: "C", status: "closed" }));

    const guildOne = store.listDrops({ guildId: "  guild-1  " });
    expect(guildOne.map((drop) => drop.bottleName).sort()).toEqual(["A", "C"]);
    expect(store.listDrops({ guildId: "guild-1", status: "open" }).map((drop) => drop.id)).toEqual([
      openA.id,
    ]);
    store.close();
  });
});

describe("signup helpers", () => {
  test("creates a signup with joined-at order and pending pickup by default", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    const first = store.createSignup({
      dropId: drop.id,
      userId: "user-1",
      status: "allocated",
      joinedAt: "2026-10-24T12:00:00.000Z",
    });
    const second = store.createSignup({
      dropId: drop.id,
      userId: "user-2",
      status: "waitlist",
      joinedAt: "2026-10-24T12:00:01.000Z",
    });

    expect(first).toMatchObject({
      dropId: drop.id,
      userId: "user-1",
      joinedAt: "2026-10-24T12:00:00.000Z",
      status: "allocated",
      pickupStatus: "pending",
      removedBy: null,
      removedAt: null,
    });
    expect(store.listSignups(drop.id).map((row) => row.userId)).toEqual(["user-1", "user-2"]);
    expect(store.listSignups(drop.id, { status: "waitlist" })).toEqual([second]);
    store.close();
  });

  test("orders sign-ups by joined-at even when inserts arrive out of order", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    store.createSignup({
      dropId: drop.id,
      userId: "late",
      status: "waitlist",
      joinedAt: "2026-10-24T12:00:10.000Z",
    });
    store.createSignup({
      dropId: drop.id,
      userId: "early",
      status: "allocated",
      joinedAt: "2026-10-24T12:00:01.000Z",
    });

    expect(store.listSignups(drop.id).map((row) => row.userId)).toEqual(["early", "late"]);
    store.close();
  });

  test("tie-breaks same joined-at timestamps by insert sequence", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    const joinedAt = "2026-10-24T12:00:00.000Z";
    store.createSignup({
      dropId: drop.id,
      userId: "first-insert",
      status: "allocated",
      joinedAt,
    });
    store.createSignup({
      dropId: drop.id,
      userId: "second-insert",
      status: "waitlist",
      joinedAt,
    });

    expect(store.listSignups(drop.id).map((row) => row.userId)).toEqual([
      "first-insert",
      "second-insert",
    ]);
    store.close();
  });

  test("requires remover info when removed and clears it on re-allocate", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    store.createSignup({
      dropId: drop.id,
      userId: "user-1",
      status: "allocated",
    });

    expect(() => store.updateSignup(drop.id, "user-1", { status: "removed" })).toThrow(
      DropValidationError
    );

    const removed = store.updateSignup(drop.id, "user-1", {
      status: "removed",
      removedBy: "mod-2",
      removedAt: "2026-10-24T13:00:00.000Z",
    });
    expect(removed).toMatchObject({
      status: "removed",
      removedBy: "mod-2",
      removedAt: "2026-10-24T13:00:00.000Z",
    });

    const pickedUp = store.updateSignup(drop.id, "user-1", { pickupStatus: "picked_up" });
    expect(pickedUp.pickupStatus).toBe("picked_up");
    expect(store.updateSignup(drop.id, "user-1", { pickupStatus: "no_show" }).pickupStatus).toBe(
      "no_show"
    );

    const reallocated = store.updateSignup(drop.id, "user-1", { status: "allocated" });
    expect(reallocated).toMatchObject({
      status: "allocated",
      removedBy: null,
      removedAt: null,
    });
    expect(() => store.updateSignup(drop.id, "missing", { status: "removed" })).toThrow(
      SignupNotFoundError
    );
    store.close();
  });

  test("rejects a second sign-up for the same user and drop", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    store.createSignup({
      dropId: drop.id,
      userId: "user-1",
      status: "allocated",
    });

    expect(() =>
      store.createSignup({
        dropId: drop.id,
        userId: "user-1",
        status: "waitlist",
      })
    ).toThrow(DuplicateSignupError);
    expect(store.listSignups(drop.id)).toHaveLength(1);
    store.close();
  });

  test("enforces one sign-up per user per drop as a PRIMARY KEY unique violation", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    store.createSignup({
      dropId: drop.id,
      userId: "user-1",
      status: "allocated",
    });

    let rawError;
    try {
      store.db
        .query(
          `INSERT INTO signups (
            drop_id, user_id, joined_at, status, pickup_status, removed_by, removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(drop.id, "user-1", new Date().toISOString(), "waitlist", "pending", null, null);
    } catch (error) {
      rawError = error;
    }

    expect(rawError).toBeDefined();
    expect(rawError.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(rawError.message).toMatch(/UNIQUE constraint failed: signups\./i);
    store.close();
  });

  test("maps a missing drop foreign key to DropNotFoundError", () => {
    const store = memoryDrops();
    expect(() =>
      store.createSignup({
        dropId: "missing-drop",
        userId: "user-1",
        status: "allocated",
      })
    ).toThrow(DropNotFoundError);
    store.close();
  });

  test("rejects sign-ups on closed or canceled drops", () => {
    const store = memoryDrops();
    const closed = store.createDrop(sampleDrop({ bottleName: "Closed", status: "closed" }));
    const canceled = store.createDrop(sampleDrop({ bottleName: "Canceled", status: "canceled" }));
    expect(() =>
      store.createSignup({
        dropId: closed.id,
        userId: "user-1",
        status: "allocated",
      })
    ).toThrow(DropValidationError);
    expect(() =>
      store.createSignup({
        dropId: canceled.id,
        userId: "user-1",
        status: "waitlist",
      })
    ).toThrow(DropValidationError);
    expect(store.listSignups(closed.id)).toEqual([]);
    expect(store.listSignups(canceled.id)).toEqual([]);
    store.close();
  });

  test("rejects invalid signup or pickup status", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    expect(() =>
      store.createSignup({
        dropId: drop.id,
        userId: "user-1",
        status: "in",
      })
    ).toThrow(DropValidationError);
    store.createSignup({
      dropId: drop.id,
      userId: "user-1",
      status: "allocated",
    });
    expect(() => store.updateSignup(drop.id, "user-1", { pickupStatus: "done" })).toThrow(
      DropValidationError
    );
    expect(() => store.updateSignup(drop.id, "user-1", { pickupStatus: "pickedUp" })).toThrow(
      DropValidationError
    );
    store.close();
  });
});

describe("drop store persistence", () => {
  test("survives close and reopen on the same data dir", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-drops-persist-"));
    try {
      const first = new DropStore({ dataDir });
      const drop = first.createDrop(
        sampleDrop({
          bottleName: "Weller Antique",
          description: "Caramel and oak.",
          bottleLimit: 4,
        })
      );
      first.createSignup({
        dropId: drop.id,
        userId: "user-9",
        status: "allocated",
        joinedAt: "2026-10-24T15:00:00.000Z",
      });
      first.close();

      const second = new DropStore({ dataDir });
      expect(second.db.query("PRAGMA user_version").get().user_version).toBe(SCHEMA_VERSION);
      expect(second.getDrop(drop.id)).toMatchObject({
        bottleName: "Weller Antique",
        description: "Caramel and oak.",
        bottleLimit: 4,
      });
      expect(second.getSignup(drop.id, "user-9")).toMatchObject({
        userId: "user-9",
        status: "allocated",
        joinedAt: "2026-10-24T15:00:00.000Z",
      });
      second.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("migrates an unversioned file to add description and rewrite pickup labels", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-drops-migrate-"));
    const dbPath = path.join(dataDir, "drops.sqlite");
    try {
      const legacy = new Database(dbPath, { create: true });
      legacy.exec(`
        CREATE TABLE drops (
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
        CREATE TABLE signups (
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
      `);
      legacy
        .query(
          `INSERT INTO drops (
            id, guild_id, channel_id, message_id, bottle_name, price, location,
            bottle_limit, close_time, status, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "legacy-1",
          "guild-1",
          "channel-1",
          null,
          "Weller Special Reserve",
          null,
          null,
          2,
          null,
          "open",
          "mod-1"
        );
      legacy
        .query(
          `INSERT INTO signups (
            drop_id, user_id, joined_at, status, pickup_status, removed_by, removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("legacy-1", "user-1", "2026-10-24T15:00:00.000Z", "allocated", "pickedUp", null, null);
      expect(legacy.query("PRAGMA user_version").get().user_version).toBe(0);
      legacy.close();

      const store = new DropStore({ dataDir });
      expect(store.db.query("PRAGMA user_version").get().user_version).toBe(SCHEMA_VERSION);
      expect(tableSql(store.db, "drops")).toMatch(/description/i);
      expect(tableSql(store.db, "signups")).toMatch(/picked_up/);
      expect(tableSql(store.db, "signups")).not.toMatch(/pickedUp/);

      const drop = store.getDrop("legacy-1");
      expect(drop).toMatchObject({
        bottleName: "Weller Special Reserve",
        description: null,
        bottleLimit: 2,
      });
      expect(store.updateDrop("legacy-1", { description: "Soft caramel." }).description).toBe(
        "Soft caramel."
      );
      expect(store.getSignup("legacy-1", "user-1")).toMatchObject({
        userId: "user-1",
        pickupStatus: "picked_up",
      });
      store.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
