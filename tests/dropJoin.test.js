import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageFlags } from "discord.js";
import Drop from "../src/commands/slash/drop.js";
import DropStore, {
  DropNotFoundError,
  DropNotOpenError,
  DropValidationError,
} from "../src/db/drops.js";
import {
  formatDropClosedReply,
  formatJoinReply,
  formatSignupCounts,
  inButtonCustomId,
} from "../src/util/dropPost.js";

function silentLogger() {
  return {
    errors: [],
    info() {},
    warn() {},
    debug() {},
    cmd() {},
    ready() {},
    time() {},
    error(err) {
      this.errors.push(err);
    },
  };
}

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

function dropClient(store = memoryDrops(), extras = {}) {
  return {
    logger: silentLogger(),
    drops: store,
    ...extras,
  };
}

function buttonInteraction({ dropId, userId, extras = {} }) {
  const replies = [];
  const edits = [];
  const channelEdits = [];
  const interaction = {
    customId: inButtonCustomId(dropId),
    user: { id: userId },
    replies,
    edits,
    channelEdits,
    reply: async (payload) => {
      replies.push(payload);
      interaction.replied = true;
    },
    message: {
      id: "msg-drop",
      edit: async (payload) => {
        edits.push(payload);
        return payload;
      },
    },
    channel: {
      messages: {
        edit: async (messageId, payload) => {
          channelEdits.push({ messageId, payload });
          return payload;
        },
      },
    },
    ...extras,
  };
  return interaction;
}

async function pressIn(command, dropId, userId, extras = {}) {
  const interaction = buttonInteraction({ dropId, userId, extras });
  const result = await command.button(interaction);
  return { interaction, result };
}

function waitForJoinWorkers(workers, gate, userCount) {
  return new Promise((resolve, reject) => {
    const results = [];
    let ready = 0;
    const timer = setTimeout(() => {
      reject(new Error(`join workers timed out (${results.length}/${userCount} done, ${ready} ready)`));
    }, 15_000);

    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    for (const worker of workers) {
      worker.onmessage = (event) => {
        if (event.data?.type === "ready") {
          ready += 1;
          if (ready === userCount) {
            Atomics.store(gate, 0, 1);
            Atomics.notify(gate, 0);
          }
          return;
        }
        if (event.data?.type === "done") {
          results.push(event.data);
          if (results.length === userCount) {
            finish(null, results);
          }
        }
      };
      worker.onerror = (error) => finish(error);
    }
  });
}

async function joinWithWorkers({ dataDir, dropId, userIds }) {
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  const workerUrl = new URL("./helpers/joinSignupWorker.js", import.meta.url);
  const workers = userIds.map(() => new Worker(workerUrl));
  const finished = waitForJoinWorkers(workers, gate, userIds.length);
  for (const [index, worker] of workers.entries()) {
    worker.postMessage({ sab, dataDir, dropId, userId: userIds[index] });
  }

  try {
    return await finished;
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
  }
}

describe("join reply copy", () => {
  test("formats allocated, waitlisted, and closed/canceled replies", () => {
    expect(formatJoinReply({ signup: { status: "allocated" }, position: 4 })).toBe(
      "You're in (#4)"
    );
    expect(formatJoinReply({ signup: { status: "waitlist" }, position: 2 })).toBe(
      "Waitlisted (#2)"
    );
    expect(formatJoinReply({ signup: { status: "removed" }, position: null })).toBe(
      "You're not currently signed up for this drop."
    );
    expect(formatDropClosedReply("closed")).toBe("This drop is closed.");
    expect(formatDropClosedReply("canceled")).toBe("This drop was canceled.");
  });
});

describe("joinSignup allocation", () => {
  test("allocates new sign-ups in joined-at order until the bottle limit", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 2 }));

    const first = store.joinSignup(drop.id, "user-1", { joinedAt: "2026-10-24T12:00:00.000Z" });
    const second = store.joinSignup(drop.id, "user-2", { joinedAt: "2026-10-24T12:00:01.000Z" });

    expect(first).toMatchObject({
      created: true,
      position: 1,
      signup: { userId: "user-1", status: "allocated" },
      counts: { allocated: 1, waitlisted: 0, bottleLimit: 2 },
    });
    expect(second).toMatchObject({
      created: true,
      position: 2,
      signup: { userId: "user-2", status: "allocated" },
      counts: { allocated: 2, waitlisted: 0, bottleLimit: 2 },
    });
    expect(store.listSignups(drop.id).map((row) => row.userId)).toEqual(["user-1", "user-2"]);
    store.close();
  });

  test("waitlists sign-ups after the bottle limit is reached", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 2 }));
    store.joinSignup(drop.id, "user-1", { joinedAt: "2026-10-24T12:00:00.000Z" });
    store.joinSignup(drop.id, "user-2", { joinedAt: "2026-10-24T12:00:01.000Z" });
    const waitlisted = store.joinSignup(drop.id, "user-3", {
      joinedAt: "2026-10-24T12:00:02.000Z",
    });
    const secondWait = store.joinSignup(drop.id, "user-4", {
      joinedAt: "2026-10-24T12:00:03.000Z",
    });

    expect(waitlisted).toMatchObject({
      created: true,
      position: 1,
      signup: { status: "waitlist", userId: "user-3" },
      counts: { allocated: 2, waitlisted: 1, bottleLimit: 2 },
    });
    expect(secondWait).toMatchObject({
      created: true,
      position: 2,
      signup: { status: "waitlist", userId: "user-4" },
      counts: { allocated: 2, waitlisted: 2, bottleLimit: 2 },
    });
    expect(store.listSignups(drop.id, { status: "allocated" })).toHaveLength(2);
    expect(store.listSignups(drop.id, { status: "waitlist" }).map((row) => row.userId)).toEqual([
      "user-3",
      "user-4",
    ]);
    store.close();
  });

  test("allocates everyone when the drop has no bottle limit", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: null }));
    const results = ["u1", "u2", "u3"].map((userId, index) =>
      store.joinSignup(drop.id, userId, {
        joinedAt: `2026-10-24T12:00:0${index}.000Z`,
      })
    );

    expect(results.map((row) => row.signup.status)).toEqual([
      "allocated",
      "allocated",
      "allocated",
    ]);
    expect(results[2]).toMatchObject({
      position: 3,
      counts: { allocated: 3, waitlisted: 0, bottleLimit: null },
    });
    store.close();
  });

  test("duplicate joins do not insert a second row and return current status and position", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 1 }));
    const first = store.joinSignup(drop.id, "user-1", { joinedAt: "2026-10-24T12:00:00.000Z" });
    store.joinSignup(drop.id, "user-2", { joinedAt: "2026-10-24T12:00:01.000Z" });
    const againAllocated = store.joinSignup(drop.id, "user-1");
    const againWaitlisted = store.joinSignup(drop.id, "user-2");

    expect(first.created).toBe(true);
    expect(againAllocated).toMatchObject({
      created: false,
      position: 1,
      signup: { userId: "user-1", status: "allocated", joinedAt: "2026-10-24T12:00:00.000Z" },
    });
    expect(againWaitlisted).toMatchObject({
      created: false,
      position: 1,
      signup: { userId: "user-2", status: "waitlist" },
    });
    expect(store.listSignups(drop.id)).toHaveLength(2);
    store.close();
  });

  test("does not promote a waitlisted duplicate if a later press happens after the limit is full", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 1 }));
    store.joinSignup(drop.id, "user-1");
    const waitlisted = store.joinSignup(drop.id, "user-2");
    const again = store.joinSignup(drop.id, "user-2");

    expect(waitlisted.signup.status).toBe("waitlist");
    expect(again.created).toBe(false);
    expect(again.signup.status).toBe("waitlist");
    expect(store.getSignup(drop.id, "user-2").status).toBe("waitlist");
    store.close();
  });

  test("rejects joins on closed or canceled drops and does not insert a row", () => {
    const store = memoryDrops();
    const closed = store.createDrop(sampleDrop({ bottleName: "Closed", status: "closed" }));
    const canceled = store.createDrop(sampleDrop({ bottleName: "Canceled", status: "canceled" }));

    expect(() => store.joinSignup(closed.id, "user-1")).toThrow(DropNotOpenError);
    expect(() => store.joinSignup(canceled.id, "user-1")).toThrow(DropValidationError);
    try {
      store.joinSignup(canceled.id, "user-1");
    } catch (error) {
      expect(error).toBeInstanceOf(DropNotOpenError);
      expect(error.dropStatus).toBe("canceled");
    }
    expect(store.listSignups(closed.id)).toEqual([]);
    expect(store.listSignups(canceled.id)).toEqual([]);
    store.close();
  });

  test("maps a missing drop to DropNotFoundError", () => {
    const store = memoryDrops();
    expect(() => store.joinSignup("missing-drop", "user-1")).toThrow(DropNotFoundError);
    store.close();
  });

  test("simultaneous joins across connections never over-allocate bottles", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-join-race-"));
    const parent = new DropStore({ dataDir });
    const drop = parent.createDrop(sampleDrop({ bottleLimit: 5, bottleName: "Race" }));
    const userIds = Array.from({ length: 20 }, (_, index) => `user-${index}`);

    try {
      const results = await joinWithWorkers({ dataDir, dropId: drop.id, userIds });
      expect(results).toHaveLength(20);
      expect(results.every((row) => row.ok)).toBe(true);

      const signups = parent.listSignups(drop.id);
      const allocated = signups.filter((row) => row.status === "allocated");
      const waitlisted = signups.filter((row) => row.status === "waitlist");
      expect(allocated).toHaveLength(5);
      expect(waitlisted).toHaveLength(15);
      expect(signups).toHaveLength(20);
      expect(new Set(signups.map((row) => row.userId)).size).toBe(20);
    } finally {
      parent.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("simultaneous duplicate presses from one user insert a single row", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-join-dup-"));
    const parent = new DropStore({ dataDir });
    const drop = parent.createDrop(sampleDrop({ bottleLimit: 3 }));
    const userIds = Array.from({ length: 8 }, () => "same-user");

    try {
      const results = await joinWithWorkers({ dataDir, dropId: drop.id, userIds });
      expect(results.every((row) => row.ok)).toBe(true);
      expect(results.filter((row) => row.created)).toHaveLength(1);
      expect(parent.listSignups(drop.id)).toHaveLength(1);
      expect(parent.getSignup(drop.id, "same-user").status).toBe("allocated");
    } finally {
      parent.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("In button handler", () => {
  test("allocates under the limit and replies privately with position", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 12, messageId: "msg-drop" }));
    const command = new Drop(dropClient(store));

    const first = await pressIn(command, drop.id, "user-1");
    const second = await pressIn(command, drop.id, "user-2");

    expect(first.interaction.replies[0]).toEqual({
      content: "You're in (#1)",
      flags: MessageFlags.Ephemeral,
    });
    expect(second.interaction.replies[0]).toEqual({
      content: "You're in (#2)",
      flags: MessageFlags.Ephemeral,
    });
    expect(store.getSignup(drop.id, "user-1").status).toBe("allocated");
    store.close();
  });

  test("waitlists past the limit and reports waitlist position", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 1, messageId: "msg-drop" }));
    const command = new Drop(dropClient(store));

    await pressIn(command, drop.id, "user-1");
    const waitlisted = await pressIn(command, drop.id, "user-2");

    expect(waitlisted.interaction.replies[0]).toEqual({
      content: "Waitlisted (#1)",
      flags: MessageFlags.Ephemeral,
    });
    expect(store.getSignup(drop.id, "user-2").status).toBe("waitlist");
    store.close();
  });

  test("unlimited drops allocate every press", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ messageId: "msg-drop" }));
    const command = new Drop(dropClient(store));

    const replies = [];
    for (const userId of ["a", "b", "c"]) {
      const { interaction } = await pressIn(command, drop.id, userId);
      replies.push(interaction.replies[0].content);
    }

    expect(replies).toEqual(["You're in (#1)", "You're in (#2)", "You're in (#3)"]);
    expect(store.listSignups(drop.id).every((row) => row.status === "allocated")).toBe(true);
    store.close();
  });

  test("duplicate presses reply with the current status and position and do not add a row", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 1, messageId: "msg-drop" }));
    const command = new Drop(dropClient(store));

    await pressIn(command, drop.id, "user-1");
    await pressIn(command, drop.id, "user-2");
    const allocatedAgain = await pressIn(command, drop.id, "user-1");
    const waitlistedAgain = await pressIn(command, drop.id, "user-2");

    expect(allocatedAgain.interaction.replies[0].content).toBe("You're in (#1)");
    expect(waitlistedAgain.interaction.replies[0].content).toBe("Waitlisted (#1)");
    expect(allocatedAgain.result.created).toBe(false);
    expect(store.listSignups(drop.id)).toHaveLength(2);
    store.close();
  });

  test("closed and canceled drops get a polite refusal and no sign-up", async () => {
    const store = memoryDrops();
    const closed = store.createDrop(
      sampleDrop({ bottleName: "Closed", status: "closed", messageId: "msg-closed" })
    );
    const canceled = store.createDrop(
      sampleDrop({ bottleName: "Canceled", status: "canceled", messageId: "msg-canceled" })
    );
    const command = new Drop(dropClient(store));

    const closedPress = await pressIn(command, closed.id, "user-1");
    const canceledPress = await pressIn(command, canceled.id, "user-1");

    expect(closedPress.interaction.replies[0]).toEqual({
      content: "This drop is closed.",
      flags: MessageFlags.Ephemeral,
    });
    expect(canceledPress.interaction.replies[0]).toEqual({
      content: "This drop was canceled.",
      flags: MessageFlags.Ephemeral,
    });
    expect(closedPress.interaction.edits).toEqual([]);
    expect(store.listSignups(closed.id)).toEqual([]);
    expect(store.listSignups(canceled.id)).toEqual([]);
    store.close();
  });

  test("updates the live count on the post after every press", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 2, messageId: "msg-drop" }));
    const command = new Drop(dropClient(store));

    const first = await pressIn(command, drop.id, "user-1");
    const second = await pressIn(command, drop.id, "user-2");
    const third = await pressIn(command, drop.id, "user-3");
    const duplicate = await pressIn(command, drop.id, "user-1");

    const counts = [first, second, third, duplicate].map((press) => {
      const embed = press.interaction.edits[0].embeds[0].toJSON();
      return embed.fields.find((field) => field.name === "Sign-ups").value;
    });

    expect(counts).toEqual([
      formatSignupCounts({ allocated: 1, waitlisted: 0, bottleLimit: 2 }),
      formatSignupCounts({ allocated: 2, waitlisted: 0, bottleLimit: 2 }),
      formatSignupCounts({ allocated: 2, waitlisted: 1, bottleLimit: 2 }),
      formatSignupCounts({ allocated: 2, waitlisted: 1, bottleLimit: 2 }),
    ]);
    expect(first.interaction.edits[0].components[0].toJSON().components[0].custom_id).toBe(
      inButtonCustomId(drop.id)
    );
    store.close();
  });

  test("falls back to channel message edit when interaction.message.edit is missing", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 4, messageId: "msg-42" }));
    const command = new Drop(dropClient(store));
    const { interaction } = await pressIn(command, drop.id, "user-1", {
      message: {},
    });

    expect(interaction.channelEdits).toHaveLength(1);
    expect(interaction.channelEdits[0].messageId).toBe("msg-42");
    const embed = interaction.channelEdits[0].payload.embeds[0].toJSON();
    expect(embed.fields.find((field) => field.name === "Sign-ups").value).toBe("1/4 in, 0 waitlisted");
    store.close();
  });

  test("unknown customIds, missing users, missing drops, and missing storage reply privately", async () => {
    const store = memoryDrops();
    const command = new Drop(dropClient(store));
    const replies = [];

    await command.button({
      customId: "drop:out:nope",
      user: { id: "user-1" },
      reply: async (payload) => replies.push(payload),
    });
    await command.button({
      customId: inButtonCustomId("drop-1"),
      user: {},
      reply: async (payload) => replies.push(payload),
    });
    await command.button({
      customId: inButtonCustomId("missing-drop"),
      user: { id: "user-1" },
      reply: async (payload) => replies.push(payload),
    });

    const noStore = new Drop({ logger: silentLogger() });
    await noStore.button({
      customId: inButtonCustomId("drop-1"),
      user: { id: "user-1" },
      reply: async (payload) => replies.push(payload),
    });

    expect(replies.map((row) => row.content)).toEqual([
      "Unknown drop action.",
      "Could not determine who pressed In.",
      "That drop could not be found.",
      "Drop storage is not available.",
    ]);
    expect(replies.every((row) => row.flags === MessageFlags.Ephemeral)).toBe(true);
    store.close();
  });

  test("keeps the sign-up if the live-count edit fails", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ messageId: "msg-drop" }));
    const logger = silentLogger();
    const command = new Drop(dropClient(store, { logger }));
    const { interaction } = await pressIn(command, drop.id, "user-1", {
      message: {
        edit: async () => {
          throw new Error("Missing Permissions");
        },
      },
    });

    expect(interaction.replies[0].content).toBe("You're in (#1)");
    expect(store.getSignup(drop.id, "user-1").status).toBe("allocated");
    expect(String(logger.errors[0]?.message || logger.errors[0])).toMatch(/Missing Permissions/);
    store.close();
  });
});
