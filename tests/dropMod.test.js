import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageFlags, PermissionsBitField } from "discord.js";
import Drop from "../src/commands/slash/drop.js";
import DropStore from "../src/db/drops.js";
import {
  DROP_MANAGE_DENIED,
  SIGNUP_CSV_HEADERS,
  buildModListPayload,
  buildSignupCsv,
  csvFilename,
  dropAutocompleteChoices,
  escapeCsvField,
  formatModListDescription,
  formatPickupReply,
  formatRemoveReply,
  hasDropManagePermission,
  parsePickupButtonCustomId,
  pickupButtonCustomId,
  resolveModDrop,
  rosterSections,
} from "../src/util/dropMod.js";

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

function dropClient(store = memoryDrops()) {
  return {
    logger: silentLogger(),
    drops: store,
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
    getFocused: (full) =>
      values.focused ?? (full ? { name: "drop", value: values.drop ?? "" } : values.drop ?? ""),
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

function seedLimitedDrop(store) {
  const drop = store.createDrop(
    sampleDrop({ id: "drop-1", bottleLimit: 2, messageId: "msg-drop" })
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

function waitForWorkers(workers, gate, expected) {
  return new Promise((resolve, reject) => {
    const results = [];
    let ready = 0;
    const timer = setTimeout(() => {
      reject(new Error(`workers timed out (${results.length}/${expected} done, ${ready} ready)`));
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
          if (ready === expected) {
            Atomics.store(gate, 0, 1);
            Atomics.notify(gate, 0);
          }
          return;
        }
        if (event.data?.type === "done") {
          results.push(event.data);
          if (results.length === expected) {
            finish(null, results);
          }
        }
      };
      worker.onerror = (error) => finish(error);
    }
  });
}

describe("mod list formatting and CSV", () => {
  test("lists allocated people first, then the waitlist, in joined-at order", () => {
    const signups = [
      {
        userId: "late-wait",
        status: "waitlist",
        pickupStatus: "pending",
        joinedAt: "2026-10-24T12:00:03.000Z",
      },
      {
        userId: "second-in",
        status: "allocated",
        pickupStatus: "picked_up",
        joinedAt: "2026-10-24T12:00:01.000Z",
      },
      {
        userId: "first-in",
        status: "allocated",
        pickupStatus: "pending",
        joinedAt: "2026-10-24T12:00:00.000Z",
      },
      {
        userId: "early-wait",
        status: "waitlist",
        pickupStatus: "pending",
        joinedAt: "2026-10-24T12:00:02.000Z",
      },
      {
        userId: "gone",
        status: "removed",
        pickupStatus: "pending",
        removedBy: "mod-1",
        removedAt: "2026-10-24T13:00:00.000Z",
      },
    ];
    const ordered = [
      ...signups.filter((row) => row.status === "allocated").sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)),
      ...signups.filter((row) => row.status === "waitlist").sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)),
      ...signups.filter((row) => row.status === "removed"),
    ];

    const text = formatModListDescription(ordered, 2);
    expect(text).toContain("**Allocated** (2/2)");
    expect(text).toContain("1. <@first-in> — pending");
    expect(text).toContain("2. <@second-in> — picked up");
    expect(text).toContain("**Waitlist** (2)");
    expect(text).toContain("1. <@early-wait>");
    expect(text).toContain("2. <@late-wait>");
    expect(text).not.toContain("gone");
    expect(text.indexOf("first-in")).toBeLessThan(text.indexOf("second-in"));
    expect(text.indexOf("Allocated")).toBeLessThan(text.indexOf("Waitlist"));
    expect(text.indexOf("early-wait")).toBeLessThan(text.indexOf("late-wait"));

    const roster = rosterSections(ordered);
    expect(roster.allocated.map((row) => row.userId)).toEqual(["first-in", "second-in"]);
    expect(roster.waitlist.map((row) => row.userId)).toEqual(["early-wait", "late-wait"]);
  });

  test("escapes CSV fields and includes position, status, pickup, and removal audit", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField("plain")).toBe("plain");
    expect(escapeCsvField("has,comma")).toBe('"has,comma"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCsvField("line\r\nbreak")).toBe('"line\r\nbreak"');

    const csv = buildSignupCsv([
      {
        userId: 'user,"1"',
        status: "allocated",
        pickupStatus: "picked_up",
        joinedAt: "2026-10-24T12:00:00.000Z",
      },
      {
        userId: "user-2",
        status: "waitlist",
        pickupStatus: "pending",
        joinedAt: "2026-10-24T12:00:01.000Z",
      },
      {
        userId: "user-3",
        status: "removed",
        pickupStatus: "no_show",
        joinedAt: "2026-10-24T11:00:00.000Z",
        removedBy: "mod-2",
        removedAt: "2026-10-24T13:00:00.000Z",
      },
    ]);

    expect(csv.startsWith(`${SIGNUP_CSV_HEADERS.join(",")}\r\n`)).toBe(true);
    expect(csv).toContain('allocated,1,"user,""1""",allocated,picked_up,2026-10-24T12:00:00.000Z,,');
    expect(csv).toContain("waitlist,1,user-2,waitlist,pending,2026-10-24T12:00:01.000Z,,");
    expect(csv).toContain(
      "removed,1,user-3,removed,no_show,2026-10-24T11:00:00.000Z,mod-2,2026-10-24T13:00:00.000Z"
    );
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csvFilename({ bottleName: "EH Taylor / Small Batch" })).toBe("eh-taylor-small-batch.csv");
  });

  test("builds list pickup buttons and parses their custom ids", () => {
    const payload = buildModListPayload(
      { id: "drop-1", bottleName: "Weller", bottleLimit: 2, status: "open" },
      [
        { userId: "user-1", status: "allocated", pickupStatus: "pending" },
        { userId: "user-2", status: "allocated", pickupStatus: "pending" },
        { userId: "user-3", status: "waitlist", pickupStatus: "pending" },
      ]
    );
    expect(payload.embeds[0].toJSON().title).toBe("Weller");
    expect(payload.components).toHaveLength(2);
    const first = payload.components[0].toJSON().components;
    expect(first[0].label).toBe("Picked up #1");
    expect(first[0].custom_id).toBe(pickupButtonCustomId("drop-1", "user-1", "picked_up"));
    expect(first[1].label).toBe("No-show #1");
    expect(parsePickupButtonCustomId(first[0].custom_id)).toEqual({
      dropId: "drop-1",
      userId: "user-1",
      pickupStatus: "picked_up",
    });
    expect(parsePickupButtonCustomId("drop:in:drop-1")).toBeNull();
  });

  test("resolves the channel drop and denies a drop from another guild", () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ id: "drop-1" }));
    store.createDrop(sampleDrop({ id: "drop-2", guildId: "guild-2", bottleName: "Other" }));

    expect(resolveModDrop(store, { guildId: "guild-1", channelId: "channel-1" }).id).toBe(drop.id);
    expect(
      resolveModDrop(store, {
        guildId: "guild-1",
        channelId: "channel-1",
        dropRef: "EH Taylor Small Batch",
      }).id
    ).toBe(drop.id);
    expect(() =>
      resolveModDrop(store, { guildId: "guild-1", channelId: "channel-1", dropRef: "drop-2" })
    ).toThrow(/not in this server/);
    store.close();
  });
});

describe("/drop list, remove, pickup, export", () => {
  test("exposes the mod subcommands and keeps ManageMessages on the command", () => {
    const command = new Drop({ logger: silentLogger() });
    const json = command.data.toJSON();
    expect(json.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageMessages));
    expect(json.options.map((option) => option.name)).toEqual([
      "create",
      "list",
      "remove",
      "pickup",
      "export",
    ]);
    expect(json.options.find((option) => option.name === "remove").options.map((option) => option.name)).toEqual(
      ["user", "drop"]
    );
    expect(
      json.options.find((option) => option.name === "pickup").options.map((option) => option.name)
    ).toEqual(["user", "status", "drop"]);
  });

  test("lists allocated then waitlist as an ephemeral reply with pickup buttons", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));
    const interaction = commandInteraction({ subcommand: "list" });

    await command.execute(interaction);

    const payload = privatePayload(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe("EH Taylor Small Batch");
    expect(embed.description).toContain("1. <@user-1> — pending");
    expect(embed.description).toContain("2. <@user-2> — pending");
    expect(embed.description).toContain("1. <@user-3>");
    expect(embed.description.indexOf("user-1")).toBeLessThan(embed.description.indexOf("user-3"));
    expect(payload.components).toHaveLength(2);
    store.close();
  });

  test("denies list/remove/pickup/export without Manage Messages", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));
    const replies = [];

    for (const subcommand of ["list", "remove", "pickup", "export"]) {
      const interaction = commandInteraction({
        subcommand,
        values: {
          user: { id: "user-1" },
          status: "picked_up",
        },
        extras: { memberPermissions: managePerms(false) },
      });
      await command.execute(interaction);
      replies.push(privatePayload(interaction));
    }

    expect(replies.every((payload) => payload.content === DROP_MANAGE_DENIED)).toBe(true);
    expect(replies.every((payload) => payload.flags === MessageFlags.Ephemeral)).toBe(true);
    expect(store.getSignup("drop-1", "user-1").status).toBe("allocated");
    store.close();
  });

  test("remove without a bottle records the mod and does not promote", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));
    const interaction = commandInteraction({
      subcommand: "remove",
      values: { user: { id: "user-3" } },
    });

    const result = await command.execute(interaction);

    expect(result.promoted).toBeNull();
    expect(result.signup).toMatchObject({
      userId: "user-3",
      status: "removed",
      removedBy: "mod-1",
    });
    expect(result.signup.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(privatePayload(interaction).content).toBe("Removed <@user-3> from the list.");
    expect(store.listSignups("drop-1", { status: "allocated" })).toHaveLength(2);
    store.close();
  });

  test("remove with a bottle promotes the next waitlist person and audits the mod", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));
    const interaction = commandInteraction({
      subcommand: "remove",
      values: { user: { id: "user-1" } },
    });

    const result = await command.execute(interaction);

    expect(result.promoted.userId).toBe("user-3");
    expect(result.signup).toMatchObject({
      userId: "user-1",
      status: "removed",
      removedBy: "mod-1",
    });
    expect(store.getSignup("drop-1", "user-3").status).toBe("allocated");
    expect(privatePayload(interaction).content).toBe(
      "Removed <@user-1> from the list. <@user-3> moved up from the waitlist."
    );
    expect(interaction.channelEdits[0].messageId).toBe("msg-drop");
    store.close();
  });

  test("remove of an unknown user stays private and changes nothing", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));
    const interaction = commandInteraction({
      subcommand: "remove",
      values: { user: { id: "stranger" } },
    });

    await command.execute(interaction);

    expect(privatePayload(interaction).content).toBe("That person is not on this drop.");
    expect(store.listSignups("drop-1")).toHaveLength(3);
    store.close();
  });

  test("pickup subcommand marks picked up and no-show", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));

    const picked = commandInteraction({
      subcommand: "pickup",
      values: { user: { id: "user-1" }, status: "picked_up" },
    });
    await command.execute(picked);
    expect(store.getSignup("drop-1", "user-1").pickupStatus).toBe("picked_up");
    expect(privatePayload(picked).content).toBe("Marked <@user-1> as picked up.");

    const noShow = commandInteraction({
      subcommand: "pickup",
      values: { user: { id: "user-2" }, status: "no_show" },
    });
    await command.execute(noShow);
    expect(store.getSignup("drop-1", "user-2").pickupStatus).toBe("no_show");
    expect(privatePayload(noShow).content).toBe("Marked <@user-2> as a no-show.");

    const waitlisted = commandInteraction({
      subcommand: "pickup",
      values: { user: { id: "user-3" }, status: "picked_up" },
    });
    await command.execute(waitlisted);
    expect(privatePayload(waitlisted).content).toMatch(/only allocated/i);
    store.close();
  });

  test("pickup buttons on the list mark status and refresh the roster", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));
    const updates = [];
    const interaction = {
      customId: pickupButtonCustomId("drop-1", "user-2", "picked_up"),
      user: { id: "mod-1" },
      memberPermissions: managePerms(true),
      deferred: false,
      replied: false,
      update: async (payload) => {
        updates.push(payload);
      },
    };

    await command.button(interaction);

    expect(store.getSignup("drop-1", "user-2").pickupStatus).toBe("picked_up");
    expect(updates).toHaveLength(1);
    expect(updates[0].embeds[0].toJSON().description).toContain("<@user-2> — picked up");
    store.close();
  });

  test("pickup buttons are denied without Manage Messages", async () => {
    const store = memoryDrops();
    seedLimitedDrop(store);
    const command = new Drop(dropClient(store));
    const replies = [];
    await command.button({
      customId: pickupButtonCustomId("drop-1", "user-1", "no_show"),
      user: { id: "user-9" },
      memberPermissions: managePerms(false),
      reply: async (payload) => replies.push(payload),
    });

    expect(replies[0].content).toBe(DROP_MANAGE_DENIED);
    expect(store.getSignup("drop-1", "user-1").pickupStatus).toBe("pending");
    store.close();
  });

  test("export attaches a CSV of everyone including removed rows", async () => {
    const store = memoryDrops();
    const drop = seedLimitedDrop(store);
    store.removeSignup(drop.id, "user-1", {
      removedBy: "mod-1",
      removedAt: "2026-10-24T13:00:00.000Z",
    });
    const command = new Drop(dropClient(store));
    const interaction = commandInteraction({ subcommand: "export" });

    await command.execute(interaction);

    const payload = privatePayload(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toBe("eh-taylor-small-batch.csv");
    const csv = Buffer.from(payload.files[0].attachment).toString("utf8");
    expect(csv).toContain("section,position,user_id,status,pickup_status,joined_at,removed_by,removed_at");
    expect(csv).toContain("allocated,1,user-2,allocated,pending,");
    expect(csv).toContain("allocated,2,user-3,allocated,pending,");
    expect(csv).toContain("removed,1,user-1,removed,pending,2026-10-24T12:00:00.000Z,mod-1,2026-10-24T13:00:00.000Z");
    expect(csv).not.toContain("waitlist,");
    store.close();
  });

  test("In presses still work without Manage Messages", async () => {
    const store = memoryDrops();
    const drop = store.createDrop(sampleDrop({ bottleLimit: 2, messageId: "msg-drop" }));
    const command = new Drop(dropClient(store));
    const editReplies = [];
    await command.button({
      customId: `drop:in:${drop.id}`,
      user: { id: "user-9" },
      memberPermissions: managePerms(false),
      deferred: false,
      replied: false,
      deferReply: async () => {},
      editReply: async (payload) => editReplies.push(payload),
      message: { edit: async () => {} },
    });

    expect(editReplies[0].content).toBe("You're in (#1)");
    expect(store.getSignup(drop.id, "user-9").status).toBe("allocated");
    store.close();
  });

  test("autocompletes guild drops by bottle name", async () => {
    const store = memoryDrops();
    store.createDrop(sampleDrop({ id: "drop-a", bottleName: "Weller Antique" }));
    store.createDrop(sampleDrop({ id: "drop-b", bottleName: "Eagle Rare" }));
    const command = new Drop(dropClient(store));
    const responses = [];
    await command.autocomplete({
      guildId: "guild-1",
      options: optionBag({ focused: { name: "drop", value: "well" } }),
      respond: async (choices) => responses.push(choices),
    });

    expect(responses[0]).toEqual([{ name: "Weller Antique (open)", value: "drop-a" }]);
    expect(dropAutocompleteChoices(store.listDrops({ guildId: "guild-1" }), "rare")).toEqual([
      { name: "Eagle Rare (open)", value: "drop-b" },
    ]);
    store.close();
  });
});

describe("removeSignup races", () => {
  test("simultaneous allocated removals promote distinct waitlist people", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-remove-race-"));
    const parent = new DropStore({ dataDir });
    const drop = parent.createDrop(sampleDrop({ bottleLimit: 2 }));
    parent.createSignup({
      dropId: drop.id,
      userId: "in-1",
      status: "allocated",
      joinedAt: "2026-10-24T12:00:00.000Z",
    });
    parent.createSignup({
      dropId: drop.id,
      userId: "in-2",
      status: "allocated",
      joinedAt: "2026-10-24T12:00:01.000Z",
    });
    parent.createSignup({
      dropId: drop.id,
      userId: "wait-1",
      status: "waitlist",
      joinedAt: "2026-10-24T12:00:02.000Z",
    });
    parent.createSignup({
      dropId: drop.id,
      userId: "wait-2",
      status: "waitlist",
      joinedAt: "2026-10-24T12:00:03.000Z",
    });

    const sab = new SharedArrayBuffer(4);
    const gate = new Int32Array(sab);
    const workerUrl = new URL("./helpers/removeSignupWorker.js", import.meta.url);
    const targets = ["in-1", "in-2"];
    const workers = targets.map(() => new Worker(workerUrl));
    const finished = waitForWorkers(workers, gate, targets.length);
    for (const [index, worker] of workers.entries()) {
      worker.postMessage({
        sab,
        dataDir,
        dropId: drop.id,
        userId: targets[index],
        removedBy: "mod-1",
      });
    }

    try {
      const results = await finished;
      expect(results.every((row) => row.ok)).toBe(true);
      expect(results.filter((row) => row.alreadyRemoved)).toHaveLength(0);
      expect(new Set(results.map((row) => row.promotedUserId)).size).toBe(2);
      expect(new Set(results.map((row) => row.promotedUserId))).toEqual(new Set(["wait-1", "wait-2"]));

      const signups = parent.listSignups(drop.id);
      expect(signups.filter((row) => row.status === "allocated").map((row) => row.userId).sort()).toEqual([
        "wait-1",
        "wait-2",
      ]);
      expect(signups.filter((row) => row.status === "removed")).toHaveLength(2);
      expect(signups.filter((row) => row.status === "waitlist")).toHaveLength(0);
    } finally {
      for (const worker of workers) {
        worker.terminate();
      }
      parent.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("reply copy", () => {
  test("formats remove and pickup confirmations", () => {
    expect(
      formatRemoveReply({
        alreadyRemoved: false,
        signup: { userId: "user-1" },
        promoted: { userId: "user-2" },
      })
    ).toBe("Removed <@user-1> from the list. <@user-2> moved up from the waitlist.");
    expect(
      formatRemoveReply({
        alreadyRemoved: true,
        signup: { userId: "user-1" },
      })
    ).toBe("<@user-1> is already off the list.");
    expect(formatPickupReply({ userId: "user-1", pickupStatus: "picked_up" })).toBe(
      "Marked <@user-1> as picked up."
    );
    expect(formatPickupReply({ userId: "user-1", pickupStatus: "no_show" })).toBe(
      "Marked <@user-1> as a no-show."
    );
    expect(hasDropManagePermission({ memberPermissions: managePerms(true) })).toBe(true);
    expect(hasDropManagePermission({ memberPermissions: managePerms(false) })).toBe(false);
    expect(hasDropManagePermission({})).toBe(false);
  });
});
