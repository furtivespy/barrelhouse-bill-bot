import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

const DROP_COMMAND_NAME = "drop";
const IN_BUTTON_PREFIX = "drop:in:";
const DROP_EMBED_COLOR = 0xc4a35a;

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/;

class DropCreateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DropCreateValidationError";
  }
}

function optionalText(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new DropCreateValidationError(`${field} must be a string`);
  }
  const text = value.trim();
  return text === "" ? null : text;
}

function requiredText(value, field) {
  const text = optionalText(value, field);
  if (!text) {
    throw new DropCreateValidationError(`${field} is required`);
  }
  return text;
}

function parseBottleLimit(value) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") {
    throw new DropCreateValidationError("limit must be a positive integer");
  }

  let limit;
  if (typeof value === "number") {
    limit = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!/^[1-9]\d*$/.test(text)) {
      throw new DropCreateValidationError("limit must be a positive integer");
    }
    limit = Number(text);
  } else {
    throw new DropCreateValidationError("limit must be a positive integer");
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new DropCreateValidationError("limit must be a positive integer");
  }
  return limit;
}

function parseCloseTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean" || typeof value === "number") {
    throw new DropCreateValidationError("close time must be a valid date");
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DropCreateValidationError("close time must be a valid date");
    }
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new DropCreateValidationError("close time must be a valid date");
  }

  const text = value.trim();
  if (!text) return null;

  if (ISO_TIMESTAMP.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      throw new DropCreateValidationError("close time must be a valid date");
    }
    return parsed.toISOString();
  }

  const local = text.match(LOCAL_DATETIME);
  if (local) {
    const seconds = local[3] || "00";
    const parsed = new Date(`${local[1]}T${local[2]}:${seconds}.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new DropCreateValidationError("close time must be a valid date");
    }
    return parsed.toISOString();
  }

  throw new DropCreateValidationError(
    "close time must be an ISO 8601 date, e.g. 2026-10-24T18:00:00Z"
  );
}

function parseDropCreateInput(input = {}) {
  return {
    bottleName: requiredText(input.bottle, "bottle"),
    description: optionalText(input.description, "description"),
    price: optionalText(input.price, "price"),
    location: optionalText(input.store, "store"),
    bottleLimit: parseBottleLimit(input.limit),
    closeTime: parseCloseTime(input.closeTime),
  };
}

function readCreateOptions(interaction) {
  const options = interaction?.options;
  if (!options) {
    throw new DropCreateValidationError("bottle is required");
  }
  return {
    bottle: options.getString?.("bottle"),
    price: options.getString?.("price"),
    store: options.getString?.("store"),
    limit: options.getInteger?.("limit"),
    closeTime: options.getString?.("close_time"),
    description: options.getString?.("description"),
  };
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

function signupCountsForDrop(store, drop) {
  const signups = typeof store?.listSignups === "function" ? store.listSignups(drop.id) : [];
  return {
    ...countSignups(signups),
    bottleLimit: drop.bottleLimit ?? null,
  };
}

function formatSignupCounts({ allocated = 0, waitlisted = 0, bottleLimit = null } = {}) {
  const inPart =
    bottleLimit == null ? `${allocated} in` : `${allocated}/${bottleLimit} in`;
  return `${inPart}, ${waitlisted} waitlisted`;
}

function discordTimestamp(iso) {
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${seconds}:F>`;
}

function inButtonCustomId(dropId) {
  return `${IN_BUTTON_PREFIX}${dropId}`;
}

function parseInButtonCustomId(customId) {
  if (typeof customId !== "string" || !customId.startsWith(IN_BUTTON_PREFIX)) {
    return null;
  }
  const dropId = customId.slice(IN_BUTTON_PREFIX.length).trim();
  return dropId || null;
}

function buildInButton(dropId) {
  return new ButtonBuilder()
    .setCustomId(inButtonCustomId(dropId))
    .setLabel("In")
    .setStyle(ButtonStyle.Success);
}

function buildDropComponents(dropId) {
  return [new ActionRowBuilder().addComponents(buildInButton(dropId))];
}

function buildDropEmbed(drop, counts = {}) {
  const signupCounts = {
    allocated: counts.allocated ?? 0,
    waitlisted: counts.waitlisted ?? 0,
    bottleLimit: counts.bottleLimit ?? drop.bottleLimit ?? null,
  };
  const embed = new EmbedBuilder()
    .setTitle(drop.bottleName)
    .setColor(DROP_EMBED_COLOR)
    .setFooter({ text: drop.status === "open" ? "Open" : drop.status });

  if (drop.description) {
    embed.setDescription(drop.description);
  }

  const fields = [];
  if (drop.price) {
    fields.push({ name: "Price", value: drop.price, inline: true });
  }
  if (drop.location) {
    fields.push({ name: "Store", value: drop.location, inline: true });
  }
  if (signupCounts.bottleLimit != null) {
    fields.push({
      name: "Limit",
      value: String(signupCounts.bottleLimit),
      inline: true,
    });
  }
  if (drop.closeTime) {
    fields.push({
      name: "Closes",
      value: discordTimestamp(drop.closeTime),
      inline: true,
    });
  }
  fields.push({
    name: "Sign-ups",
    value: formatSignupCounts(signupCounts),
    inline: false,
  });
  embed.addFields(fields);
  return embed;
}

function buildDropMessage(drop, counts) {
  return {
    embeds: [buildDropEmbed(drop, counts)],
    components: buildDropComponents(drop.id),
  };
}

export {
  DROP_COMMAND_NAME,
  DROP_EMBED_COLOR,
  IN_BUTTON_PREFIX,
  DropCreateValidationError,
  parseDropCreateInput,
  readCreateOptions,
  parseCloseTime,
  countSignups,
  signupCountsForDrop,
  formatSignupCounts,
  discordTimestamp,
  inButtonCustomId,
  parseInButtonCustomId,
  buildInButton,
  buildDropComponents,
  buildDropEmbed,
  buildDropMessage,
};
