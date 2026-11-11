import { describe, expect, test } from "bun:test";
import { ButtonStyle, MessageFlags, PermissionsBitField } from "discord.js";
import Drop from "../src/commands/slash/drop.js";
import DropStore from "../src/db/drops.js";
import Ready from "../src/events/ready.js";
import { DROP_MANAGE_DENIED } from "../src/util/dropMod.js";
import { DropCloser, MAX_TIMEOUT_MS } from "../src/util/dropCloser.js";
import { formatDropSettleReply, inButtonCustomId } from "../src/util/dropPost.js";

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

function managePerms(allowed = true) {
  return {
    has: (flag) =>
      allowed &&
      (flag === PermissionsBitField.Flags.ManageMessages || flag === "ManageMessages"),
  };
}

function optionBag(values = {}) {
  return {
    getSubcommand: (required) => {
      if (values.subcommand == null && required) {
        throw new Error("missing subcommand");
      }
      return values.subcommand ?? null;
    },
    getString: (name) => (name in values ? values[name] : null),
    getInteger: (name) => (name in values ? values[name] : null),
    getUser: (name) => (name in values ? values[name] : null),
  };
}

function commandInteraction({ subcommand, extras = {}, values = {} }) {
  const replies = [];
  const editReplies = [];
  const followUps = [];
  const defers = [];
  const channelEdits = [];
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "mod-1" },
    memberPermissions: managePerms(true),
    options: optionBag({ subcommand, ...values }),
    replies,
    editReplies,
    followUps,
    defers,
    channelEdits,
    deferred: false,
    replied: false,
    deferReply: async (payload) => {
      defers.push(payload);
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      editReplies.push(payload);
    },
    followUp: async (payload) => {
      followUps.push(payload);
    },
    reply: async (payload) => {
      replies.push(payload);
      interaction.replied = true;
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

function privatePayload(interaction) {
  return interaction.editReplies[0] || interaction.followUps[0] || interaction.replies[0];
}

function dropClient(store = memoryDrops(), extras = {}) {
  return {
    logger: silentLogger(),
    drops: store,
    ...extras,
  };
}

function seedOpenDrop(store, overrides = {}) {
  const drop = store.createDrop(
    sampleDrop({ id: "drop-1", bottleLimit: 2, messageId: "msg-drop", ...overrides })
  );
  store.createSignup({
    dropId: drop.id,
    userId: "user-1",
    status: "allocated",
    joinedAt: "2026-10-24T12:00:00.000Z",
  });
  store.createSignup({
    dropId: drop.id,
    userId: "user-2",
    status: "allocated",
    joinedAt: "2026-10-24T12:00:01.000Z",
  });
  store.createSignup({
    dropId: drop.id,
    userId: "user-3",
    status: "waitlist",
    joinedAt: "2026-10-24T12:00:02.000Z",
  });
  return drop;
}

function createClock(startMs) {
  let now = startMs;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimeoutFn(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) {
        timers.delete(id);
        await timer.fn();
      }
    },
    get size() {
      return timers.size;
    },
  };
}

function channelClient(store, edits, extras = {}) {
  return dropClient(store, {
    channels: {
      cache: {
        get: (id) =>
          id === "channel-1"
            ? {
                messages: {
                  edit: async (messageId, payload) => {
                    edits.push({ messageId, payload });
                    return payload;
                  },
                },
              }
            : undefined,
      },
    },
    ...extras,
  });
}

describe("drop close/cancel formatting", () => {
  test("settle replies distinguish already-closed from canceled", () => {
    expect(formatDropSettleReply("close", "closed")).toBe("That drop is already closed.");
    expect(formatDropSettleReply("close", "canceled")).toBe("That drop was canceled.");
    expect(formatDropSettleReply("cancel", "canceled")).toBe("That drop is already canceled.");
    expect(formatDropSettleReply("cancel", "closed")).toBe("That drop is already closed.");
  });
});

describe("/drop close and /drop cancel", () => {
  test("close marks the drop closed, disables In, and posts the allocated list", async () => {
    const store = memoryDrops();
    seedOpenDrop(store);
    const command = new Drop(dropClient(store));
    const interaction = commandInteraction({ subcommand: "close" });

    const result = await command.execute(interaction);

    expect(result.drop.status).toBe("closed");
    expect(store.getDrop("drop-1").status).toBe("closed");
    expect(privatePayload(interaction)).toEqual({
      content: "Drop closed. Final allocated list posted.",
    });
    expect(interaction.channelEdits).toHaveLength(1);
    expect(interaction.channelEdits[0].messageId).toBe("msg-drop");
    const embed = interaction.channelEdits[0].payload.embeds[0].toJSON();
    expect(embed.footer.text).toBe("Closed");
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: "Allocated", value: "1. <@user-1>\n2. <@user-2>", inline: false },
      ])
    );
    const button = interaction.channelEdits[0].payload.components[0].toJSON().components[0];
    expect(button.label).toBe("In");
    expect(button.disabled).toBe(true);
    expect(button.style).toBe(ButtonStyle.Success);
    store.close();
  });

  test("cancel marks the drop canceled and updates the post without an allocated list", async () => {
    const store = memoryDrops();
    seedOpenDrop(store);
    const command = new Drop(dropClient(store));
    const interaction = commandInteraction({ subcommand: "cancel" });

    const result = await command.execute(interaction);

    expect(result.drop.status).toBe("canceled");
    expect(privatePayload(interaction)).toEqual({ content: "Drop canceled." });
    const embed = interaction.channelEdits[0].payload.embeds[0].toJSON();
    expect(embed.footer.text).toBe("Canceled");
    expect(embed.fields.some((field) => field.name === "Allocated")).toBe(false);
    expect(interaction.channelEdits[0].payload.components[0].toJSON().components[0].disabled).toBe(
      true
    );
    store.close();
  });

  test("close and cancel are idempotent and refuse the other settled state", async () => {
    const store = memoryDrops();
    seedOpenDrop(store, { id: "drop-1" });
    const command = new Drop(dropClient(store));

    await command.execute(commandInteraction({ subcommand: "close" }));
    const closedAgain = commandInteraction({ subcommand: "close" });
    await command.execute(closedAgain);
    expect(privatePayload(closedAgain)).toEqual({ content: "That drop is already closed." });

    const cancelClosed = commandInteraction({ subcommand: "cancel" });
    await command.execute(cancelClosed);
    expect(privatePayload(cancelClosed)).toEqual({ content: "That drop is already closed." });

    const other = seedOpenDrop(store, { id: "drop-2", bottleName: "Blanton's", messageId: "msg-2" });
    await command.execute(
      commandInteraction({ subcommand: "cancel", values: { drop: other.id } })
    );
    const cancelAgain = commandInteraction({
      subcommand: "cancel",
      values: { drop: other.id },
    });
    await command.execute(cancelAgain);
    expect(privatePayload(cancelAgain)).toEqual({ content: "That drop is already canceled." });

    const closeCanceled = commandInteraction({
      subcommand: "close",
      values: { drop: other.id },
    });
    await command.execute(closeCanceled);
    expect(privatePayload(closeCanceled)).toEqual({ content: "That drop was canceled." });
    store.close();
  });

  test("unschedules a pending auto-close when a drop is closed or canceled by a mod", async () => {
    const store = memoryDrops();
    const drop = seedOpenDrop(store, { closeTime: "2026-10-24T18:00:00.000Z" });
    const unscheduled = [];
    const command = new Drop(
      dropClient(store, {
        dropCloser: {
          unschedule(id) {
            unscheduled.push(id);
          },
        },
      })
    );

    await command.execute(commandInteraction({ subcommand: "close" }));
    expect(unscheduled).toEqual([drop.id]);

    const other = seedOpenDrop(store, {
      id: "drop-2",
      bottleName: "Weller",
      messageId: "msg-2",
      closeTime: "2026-10-24T19:00:00.000Z",
    });
    await command.execute(
      commandInteraction({ subcommand: "cancel", values: { drop: other.id } })
    );
    expect(unscheduled).toEqual([drop.id, other.id]);
    store.close();
  });

  test("closed drop In button still refuses sign-ups", async () => {
    const store = memoryDrops();
    seedOpenDrop(store);
    const command = new Drop(dropClient(store));
    await command.execute(commandInteraction({ subcommand: "close" }));

    const interaction = {
      customId: inButtonCustomId("drop-1"),
      user: { id: "user-9" },
      deferred: false,
      replied: false,
      editReplies: [],
      deferReply: async () => {
        interaction.deferred = true;
      },
      editReply: async (payload) => {
        interaction.editReplies.push(payload);
      },
    };
    await command.button(interaction);

    expect(interaction.editReplies[0]).toEqual({ content: "This drop is closed." });
    expect(store.getSignup("drop-1", "user-9")).toBeUndefined();
    store.close();
  });

  test("canceled drop In button still refuses sign-ups", async () => {
    const store = memoryDrops();
    seedOpenDrop(store);
    const command = new Drop(dropClient(store));
    await command.execute(commandInteraction({ subcommand: "cancel" }));

    const interaction = {
      customId: inButtonCustomId("drop-1"),
      user: { id: "user-9" },
      deferred: false,
      replied: false,
      editReplies: [],
      deferReply: async () => {
        interaction.deferred = true;
      },
      editReply: async (payload) => {
        interaction.editReplies.push(payload);
      },
    };
    await command.button(interaction);

    expect(interaction.editReplies[0]).toEqual({ content: "This drop was canceled." });
    expect(store.listSignups("drop-1").every((row) => row.userId !== "user-9")).toBe(true);
    store.close();
  });
});

describe("DropCloser", () => {
  test("closes a drop at its close time and edits the original post", async () => {
    const store = memoryDrops();
    const drop = seedOpenDrop(store, { closeTime: "2026-10-24T18:00:00.000Z" });
    const edits = [];
    const clock = createClock(Date.parse("2026-10-24T17:59:00.000Z"));
    const closer = new DropCloser(channelClient(store, edits), clock);

    closer.schedule(drop);
    expect(store.getDrop(drop.id).status).toBe("open");
    expect(clock.size).toBe(1);

    await clock.advance(60_000);

    expect(store.getDrop(drop.id).status).toBe("closed");
    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe("msg-drop");
    const embed = edits[0].payload.embeds[0].toJSON();
    expect(embed.footer.text).toBe("Closed");
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: "Allocated", value: "1. <@user-1>\n2. <@user-2>", inline: false },
      ])
    );
    expect(edits[0].payload.components[0].toJSON().components[0].disabled).toBe(true);
    expect(clock.size).toBe(0);
    closer.stop();
    store.close();
  });

  test("closes overdue drops immediately on reschedulePending after a restart", async () => {
    const store = memoryDrops();
    const due = seedOpenDrop(store, {
      id: "due",
      closeTime: "2026-10-24T17:00:00.000Z",
      messageId: "msg-due",
    });
    const later = store.createDrop(
      sampleDrop({
        id: "later",
        bottleName: "Later",
        messageId: "msg-later",
        closeTime: "2026-10-24T19:00:00.000Z",
      })
    );
    store.createDrop(sampleDrop({ id: "open-forever", bottleName: "No timer" }));
    const edits = [];
    const clock = createClock(Date.parse("2026-10-24T18:00:00.000Z"));
    const closer = new DropCloser(channelClient(store, edits), clock);

    const scheduled = await closer.reschedulePending();
    expect(scheduled).toBe(2);
    expect(store.getDrop(due.id).status).toBe("closed");
    expect(store.getDrop(later.id).status).toBe("open");
    expect(edits[0].messageId).toBe("msg-due");
    expect(clock.size).toBe(1);

    await clock.advance(60 * 60 * 1000);
    expect(store.getDrop(later.id).status).toBe("closed");
    closer.stop();
    store.close();
  });

  test("re-arms timers that exceed the runtime timeout limit", async () => {
    const store = memoryDrops();
    const closeTime = "2026-12-01T00:00:00.000Z";
    const drop = seedOpenDrop(store, { closeTime });
    const edits = [];
    const start = Date.parse("2026-10-24T00:00:00.000Z");
    const clock = createClock(start);
    const closer = new DropCloser(channelClient(store, edits), clock);

    closer.schedule(drop);
    expect(clock.size).toBe(1);
    expect(store.getDrop(drop.id).status).toBe("open");

    await clock.advance(MAX_TIMEOUT_MS);
    expect(store.getDrop(drop.id).status).toBe("open");
    expect(clock.size).toBe(1);

    const remaining = Date.parse(closeTime) - (start + MAX_TIMEOUT_MS);
    await clock.advance(remaining);
    expect(store.getDrop(drop.id).status).toBe("closed");
    expect(edits).toHaveLength(1);
    closer.stop();
    store.close();
  });

  test("stop clears pending timers so they do not fire after shutdown", async () => {
    const store = memoryDrops();
    const drop = seedOpenDrop(store, { closeTime: "2026-10-24T18:00:00.000Z" });
    const clock = createClock(Date.parse("2026-10-24T17:00:00.000Z"));
    const closer = new DropCloser(channelClient(store, []), clock);
    closer.schedule(drop);
    expect(clock.size).toBe(1);
    closer.stop();
    expect(clock.size).toBe(0);
    await clock.advance(2 * 60 * 60 * 1000);
    expect(store.getDrop(drop.id).status).toBe("open");
    store.close();
  });

  test("create with a close time schedules the closer", async () => {
    const store = memoryDrops();
    const scheduled = [];
    const command = new Drop(
      dropClient(store, {
        dropCloser: {
          async schedule(drop) {
            scheduled.push(drop.id);
          },
        },
      })
    );
    const drop = await command.execute({
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "mod-1" },
      options: optionBag({
        subcommand: "create",
        bottle: "Weller",
        close_time: "2026-10-24T18:00:00Z",
      }),
      reply: async () => {},
      fetchReply: async () => ({ id: "msg-create" }),
    });

    expect(scheduled).toEqual([drop.id]);
    expect(drop.closeTime).toBe("2026-10-24T18:00:00.000Z");
    store.close();
  });
});

describe("ready reschedules pending closes", () => {
  test("clientReady asks the drop closer to reschedule", async () => {
    const calls = [];
    const client = {
      logger: silentLogger(),
      application: {
        async fetch() {
          return { owner: { id: "boss" } };
        },
      },
      dropCloser: {
        async reschedulePending() {
          calls.push("reschedule");
        },
      },
    };
    const ready = new Ready(client);
    await ready.run();
    expect(calls).toEqual(["reschedule"]);
    expect(client.appInfo).toEqual({ owner: { id: "boss" } });
  });
});
