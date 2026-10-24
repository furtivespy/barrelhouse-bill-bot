import { describe, expect, test } from "bun:test";
import {
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import Drop from "../src/commands/slash/drop.js";
import DropStore from "../src/db/drops.js";
import {
  DROP_COMMAND_NAME,
  DROP_EMBED_COLOR,
  IN_BUTTON_PREFIX,
  DropCreateValidationError,
  buildDropComponents,
  buildDropEmbed,
  buildDropMessage,
  countSignups,
  formatSignupCounts,
  inButtonCustomId,
  parseDropCreateInput,
  parseInButtonCustomId,
  readCreateOptions,
  signupCountsForDrop,
} from "../src/util/dropPost.js";

function silentLogger() {
  return {
    info() {},
    error() {},
    warn() {},
    debug() {},
    cmd() {},
    ready() {},
    time() {},
  };
}

function memoryDrops() {
  return new DropStore({ filename: ":memory:" });
}

function dropClient(store = memoryDrops()) {
  return {
    logger: silentLogger(),
    drops: store,
  };
}

function optionBag(values = {}) {
  return {
    getSubcommand: (required) => {
      if (values.subcommand == null && required) {
        throw new Error("missing subcommand");
      }
      return values.subcommand ?? "create";
    },
    getString: (name) => (name in values ? values[name] : null),
    getInteger: (name) => (name in values ? values[name] : null),
  };
}

function sampleParsed(overrides = {}) {
  return {
    bottleName: "EH Taylor Small Batch",
    description: null,
    price: null,
    location: null,
    bottleLimit: null,
    closeTime: null,
    ...overrides,
  };
}

describe("drop create option parsing", () => {
  test("requires a non-empty bottle name and trims fields", () => {
    expect(parseDropCreateInput({ bottle: "  Weller Antique  " })).toEqual(
      sampleParsed({ bottleName: "Weller Antique" })
    );
    expect(() => parseDropCreateInput({})).toThrow(DropCreateValidationError);
    expect(() => parseDropCreateInput({ bottle: "   " })).toThrow(/bottle is required/);
    expect(() => parseDropCreateInput({ bottle: 12 })).toThrow(/bottle must be a string/);
  });

  test("maps optional price, store, description, and limit onto store fields", () => {
    expect(
      parseDropCreateInput({
        bottle: "Blanton's",
        price: " $59.99 ",
        store: " Liquor Barn New Circle ",
        description: " Cherry, oak, and a little rye spice. ",
        limit: 12,
      })
    ).toEqual({
      bottleName: "Blanton's",
      description: "Cherry, oak, and a little rye spice.",
      price: "$59.99",
      location: "Liquor Barn New Circle",
      bottleLimit: 12,
      closeTime: null,
    });
  });

  test("treats omitted or blank optional fields as unlimited / unset", () => {
    expect(
      parseDropCreateInput({
        bottle: "Eagle Rare",
        price: "",
        store: "  ",
        description: null,
        limit: null,
        closeTime: "",
      })
    ).toEqual(sampleParsed({ bottleName: "Eagle Rare" }));
  });

  test("rejects a non-positive or non-integer limit", () => {
    expect(() => parseDropCreateInput({ bottle: "X", limit: 0 })).toThrow(
      /limit must be a positive integer/
    );
    expect(() => parseDropCreateInput({ bottle: "X", limit: -2 })).toThrow(
      DropCreateValidationError
    );
    expect(() => parseDropCreateInput({ bottle: "X", limit: 1.5 })).toThrow(
      DropCreateValidationError
    );
    expect(() => parseDropCreateInput({ bottle: "X", limit: true })).toThrow(
      DropCreateValidationError
    );
    expect(() => parseDropCreateInput({ bottle: "X", limit: "1e2" })).toThrow(
      DropCreateValidationError
    );
    expect(parseDropCreateInput({ bottle: "X", limit: "6" }).bottleLimit).toBe(6);
  });

  test("accepts ISO close times and YYYY-MM-DD HH:mm, rejects junk", () => {
    expect(
      parseDropCreateInput({
        bottle: "X",
        closeTime: "2026-10-24T18:00:00.000Z",
      }).closeTime
    ).toBe("2026-10-24T18:00:00.000Z");
    expect(
      parseDropCreateInput({
        bottle: "X",
        closeTime: "2026-10-24 18:00",
      }).closeTime
    ).toBe("2026-10-24T18:00:00.000Z");
    expect(
      parseDropCreateInput({
        bottle: "X",
        closeTime: "2026-10-24T18:00",
      }).closeTime
    ).toBe("2026-10-24T18:00:00.000Z");
    expect(() => parseDropCreateInput({ bottle: "X", closeTime: true })).toThrow(
      /close time must be a valid date/
    );
    expect(() => parseDropCreateInput({ bottle: "X", closeTime: "tonight" })).toThrow(
      /ISO 8601/
    );
    expect(() => parseDropCreateInput({ bottle: "X", closeTime: "2026" })).toThrow(
      DropCreateValidationError
    );
  });

  test("reads Discord slash options including close_time", () => {
    expect(
      readCreateOptions({
        options: optionBag({
          bottle: "Weller",
          price: "$40",
          store: "Party Mart",
          limit: 4,
          close_time: "2026-10-24T18:00:00Z",
          description: "Caramel.",
        }),
      })
    ).toEqual({
      bottle: "Weller",
      price: "$40",
      store: "Party Mart",
      limit: 4,
      closeTime: "2026-10-24T18:00:00Z",
      description: "Caramel.",
    });
  });
});

describe("drop embed and In button rendering", () => {
  test("formats live counts from store allocated/waitlist totals", () => {
    expect(
      formatSignupCounts({ allocated: 7, waitlisted: 3, bottleLimit: 12 })
    ).toBe("7/12 in, 3 waitlisted");
    expect(formatSignupCounts({ allocated: 0, waitlisted: 0, bottleLimit: 12 })).toBe(
      "0/12 in, 0 waitlisted"
    );
    expect(formatSignupCounts({ allocated: 4, waitlisted: 0, bottleLimit: null })).toBe(
      "4 in, 0 waitlisted"
    );

    const counts = countSignups([
      { status: "allocated" },
      { status: "allocated" },
      { status: "waitlist" },
      { status: "removed" },
    ]);
    expect(counts).toEqual({ allocated: 2, waitlisted: 1 });
    expect(formatSignupCounts({ ...counts, bottleLimit: 2 })).toBe("2/2 in, 1 waitlisted");
  });

  test("reads live counts from the drop store and ignores removed rows", () => {
    const store = memoryDrops();
    const drop = store.createDrop({
      guildId: "guild-1",
      channelId: "channel-1",
      bottleName: "EH Taylor Small Batch",
      bottleLimit: 12,
      createdBy: "mod-1",
    });
    store.createSignup({ dropId: drop.id, userId: "u1", status: "allocated" });
    store.createSignup({ dropId: drop.id, userId: "u2", status: "allocated" });
    store.createSignup({ dropId: drop.id, userId: "u3", status: "waitlist" });
    store.createSignup({
      dropId: drop.id,
      userId: "u4",
      status: "removed",
      removedBy: "mod-1",
    });

    expect(signupCountsForDrop(store, drop)).toEqual({
      allocated: 2,
      waitlisted: 1,
      bottleLimit: 12,
    });
    store.close();
  });

  test("builds an embed with bottle details and a single In button", () => {
    const drop = {
      id: "drop-1",
      bottleName: "EH Taylor Small Batch",
      description: "Cherry, oak, and a little rye spice.",
      price: "$59.99",
      location: "Liquor Barn New Circle",
      bottleLimit: 12,
      closeTime: "2026-10-24T18:00:00.000Z",
      status: "open",
    };
    const embed = buildDropEmbed(drop, {
      allocated: 7,
      waitlisted: 3,
      bottleLimit: 12,
    }).toJSON();

    expect(embed.title).toBe("EH Taylor Small Batch");
    expect(embed.description).toBe("Cherry, oak, and a little rye spice.");
    expect(embed.color).toBe(DROP_EMBED_COLOR);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: "Price", value: "$59.99", inline: true },
        { name: "Store", value: "Liquor Barn New Circle", inline: true },
        { name: "Limit", value: "12", inline: true },
        { name: "Closes", value: "<t:1792864800:F>", inline: true },
        { name: "Sign-ups", value: "7/12 in, 3 waitlisted", inline: false },
      ])
    );

    const row = buildDropComponents(drop.id)[0].toJSON();
    expect(row.components).toHaveLength(1);
    expect(row.components[0].label).toBe("In");
    expect(row.components[0].custom_id).toBe("drop:in:drop-1");
    expect(row.components[0].style).toBe(ButtonStyle.Success);
    expect(inButtonCustomId(drop.id).startsWith("drop:")).toBe(true);
    expect(inButtonCustomId(drop.id).startsWith(IN_BUTTON_PREFIX)).toBe(true);
    expect(parseInButtonCustomId("drop:in:drop-1")).toBe("drop-1");
    expect(buildDropMessage(drop, { allocated: 0, waitlisted: 0 }).components).toHaveLength(1);
  });

  test("omits empty optional embed fields and still shows the live count", () => {
    const embed = buildDropEmbed(
      {
        id: "drop-2",
        bottleName: "Eagle Rare",
        description: null,
        price: null,
        location: null,
        bottleLimit: null,
        closeTime: null,
        status: "open",
      },
      { allocated: 0, waitlisted: 0 }
    ).toJSON();

    expect(embed.description).toBeUndefined();
    expect(embed.fields).toEqual([
      { name: "Sign-ups", value: "0 in, 0 waitlisted", inline: false },
    ]);
  });
});

describe("/drop create", () => {
  test("exposes slash metadata, create options, and ManageMessages default", () => {
    const command = new Drop({ logger: silentLogger() });
    const json = command.data.toJSON();

    expect(command.data.name).toBe(DROP_COMMAND_NAME);
    expect(command.conf.permLevel).toBe("User");
    expect(json.default_member_permissions).toBe(
      String(PermissionsBitField.Flags.ManageMessages)
    );
    expect(json.dm_permission).toBe(false);

    const create = json.options.find((option) => option.name === "create");
    expect(create).toBeDefined();
    expect(create.options.map((option) => option.name)).toEqual([
      "bottle",
      "price",
      "store",
      "limit",
      "close_time",
      "description",
    ]);
    expect(create.options.find((option) => option.name === "bottle").required).toBe(true);
    expect(create.options.find((option) => option.name === "price").required).toBe(false);
  });

  test("creates a drop, posts the embed with an In button, and stores the message id", async () => {
    const store = memoryDrops();
    const command = new Drop(dropClient(store));
    const replies = [];

    const drop = await command.execute({
      guildId: "guild-1",
      channelId: "channel-9",
      user: { id: "mod-1" },
      options: optionBag({
        bottle: "EH Taylor Small Batch",
        price: "$59.99",
        store: "Liquor Barn",
        limit: 12,
        close_time: "2026-10-24T18:00:00Z",
        description: "Cherry and oak.",
      }),
      reply: async (payload) => replies.push(payload),
      fetchReply: async () => ({ id: "msg-42" }),
    });

    expect(drop).toMatchObject({
      guildId: "guild-1",
      channelId: "channel-9",
      messageId: "msg-42",
      bottleName: "EH Taylor Small Batch",
      description: "Cherry and oak.",
      price: "$59.99",
      location: "Liquor Barn",
      bottleLimit: 12,
      createdBy: "mod-1",
      status: "open",
    });
    expect(store.getDrop(drop.id).messageId).toBe("msg-42");

    expect(replies).toHaveLength(1);
    expect(replies[0].flags).toBeUndefined();
    expect(replies[0].embeds[0].toJSON().title).toBe("EH Taylor Small Batch");
    expect(replies[0].embeds[0].toJSON().fields).toEqual(
      expect.arrayContaining([
        { name: "Sign-ups", value: "0/12 in, 0 waitlisted", inline: false },
      ])
    );
    const button = replies[0].components[0].toJSON().components[0];
    expect(button.label).toBe("In");
    expect(button.custom_id).toBe(inButtonCustomId(drop.id));
    expect(button.custom_id.startsWith("drop:")).toBe(true);
    store.close();
  });

  test("replies ephemerally when bottle is missing or the command is used outside a guild", async () => {
    const command = new Drop(dropClient());
    const replies = [];

    await command.execute({
      guildId: null,
      channelId: null,
      user: { id: "mod-1" },
      options: optionBag({ bottle: "X" }),
      reply: async (payload) => replies.push(payload),
    });
    await command.execute({
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "mod-1" },
      options: optionBag({ bottle: "  " }),
      reply: async (payload) => replies.push(payload),
    });

    expect(replies[0]).toEqual({
      content: "Use /drop create in a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    expect(replies[1].content).toBe("bottle is required");
    expect(replies[1].flags).toBe(MessageFlags.Ephemeral);
    expect(command.client.drops.listDrops()).toEqual([]);
    command.client.drops.close();
  });

  test("button handler acks with an ephemeral placeholder until FUR-122", async () => {
    const command = new Drop(dropClient());
    const replies = [];
    await command.button({
      customId: "drop:in:drop-1",
      reply: async (payload) => replies.push(payload),
    });
    expect(replies[0]).toEqual({
      content: "Sign-up handling is not available yet.",
      flags: MessageFlags.Ephemeral,
    });
    command.client.drops.close();
  });
});
