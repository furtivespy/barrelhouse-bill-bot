import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import DropStore, {
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

describe("drop store schema", () => {
  test("exposes the documented status enums", () => {
    expect(DROP_STATUSES).toEqual(["open", "closed", "canceled"]);
    expect(SIGNUP_STATUSES).toEqual(["allocated", "waitlist", "removed"]);
    expect(PICKUP_STATUSES).toEqual(["pending", "pickedUp", "noShow"]);
  });

  test("creates drops and signups tables with the unique signup key", () => {
    const store = memoryDrops();
    const tables = store.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["drops", "signups"]));

    const signupSql = store.db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'signups'")
      .get().sql;
    expect(signupSql).toMatch(/PRIMARY KEY \(drop_id, user_id\)/);
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

  test("stores optional price, location, limit, close time, and message id", () => {
    const store = memoryDrops();
    const closeTime = "2026-10-24T18:00:00.000Z";
    const drop = store.createDrop(
      sampleDrop({
        messageId: "msg-1",
        price: "$59.99",
        location: "Liquor Barn New Circle",
        bottleLimit: 12,
        closeTime,
      })
    );

    expect(drop).toMatchObject({
      messageId: "msg-1",
      price: "$59.99",
      location: "Liquor Barn New Circle",
      bottleLimit: 12,
      closeTime,
    });
    store.close();
  });

  test("treats a missing bottle limit as unlimited and rejects zero or negative limits", () => {
    const store = memoryDrops();
    expect(store.createDrop(sampleDrop()).bottleLimit).toBeNull();
    expect(() => store.createDrop(sampleDrop({ bottleLimit: 0 }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ bottleLimit: -2 }))).toThrow(DropValidationError);
    store.close();
  });

  test("rejects missing required fields and invalid status", () => {
    const store = memoryDrops();
    expect(() => store.createDrop({})).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ bottleName: "  " }))).toThrow(DropValidationError);
    expect(() => store.createDrop(sampleDrop({ status: "pending" }))).toThrow(DropValidationError);
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

  test("lists drops by guild and status", () => {
    const store = memoryDrops();
    const openA = store.createDrop(sampleDrop({ bottleName: "A" }));
    store.createDrop(sampleDrop({ guildId: "guild-2", bottleName: "B" }));
    store.createDrop(sampleDrop({ bottleName: "C", status: "closed" }));

    const guildOne = store.listDrops({ guildId: "guild-1" });
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

  test("records who removed a person and when, and pickup status", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop());
    store.createSignup({
      dropId: drop.id,
      userId: "user-1",
      status: "allocated",
    });

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

    const pickedUp = store.updateSignup(drop.id, "user-1", { pickupStatus: "pickedUp" });
    expect(pickedUp.pickupStatus).toBe("pickedUp");
    expect(store.updateSignup(drop.id, "user-1", { pickupStatus: "noShow" }).pickupStatus).toBe(
      "noShow"
    );
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

  test("enforces one sign-up per user per drop at the database level", () => {
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
    expect(String(rawError.code || rawError.message)).toMatch(/CONSTRAINT|unique|PRIMARY KEY/i);
    store.close();
  });

  test("does not create a signup for a missing drop", () => {
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
    store.close();
  });
});

describe("drop store persistence", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-drops-"));

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("survives close and reopen on the same data dir", () => {
    const first = new DropStore({ dataDir });
    const drop = first.createDrop(
      sampleDrop({
        bottleName: "Weller Antique",
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
    expect(second.getDrop(drop.id).bottleName).toBe("Weller Antique");
    expect(second.getSignup(drop.id, "user-9")).toMatchObject({
      userId: "user-9",
      status: "allocated",
      joinedAt: "2026-10-24T15:00:00.000Z",
    });
    second.close();
  });

  test("opens the same schema when pointed at an existing sqlite file", () => {
    const dbPath = path.join(dataDir, "drops.sqlite");
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    const count = db.query("SELECT COUNT(*) AS n FROM signups").get().n;
    expect(count).toBeGreaterThan(0);
    db.close();
  });
});
