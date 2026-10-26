import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import {
  DropValidationError,
  optionalBottleLimit,
  optionalText,
  optionalTimestamp,
  requiredText,
} from "../db/drops.js";
import {
  DEFAULT_TIME_ZONE,
  instantToIso,
  resolveTimeZone,
  zonedPlainToIso,
} from "./timeZone.js";

const DROP_COMMAND_NAME = "drop";
const IN_BUTTON_PREFIX = "drop:in:";
const DROP_EMBED_COLOR = 0xc4a35a;

const HAS_DATE_AND_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const HAS_EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

class DropCreateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DropCreateValidationError";
  }
}

function withCreateValidation(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof DropValidationError) {
      throw new DropCreateValidationError(error.message);
    }
    throw error;
  }
}

function parseCloseTimeString(text, timeZone) {
  const normalized = text.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, "$1T$2");
  if (!HAS_DATE_AND_TIME.test(normalized)) {
    throw new DropCreateValidationError(
      "close time must be an ISO 8601 date, e.g. 2026-10-24T18:00:00Z or 2026-10-24 18:00"
    );
  }

  try {
    if (HAS_EXPLICIT_OFFSET.test(normalized)) {
      return instantToIso(normalized);
    }
    return zonedPlainToIso(normalized, resolveTimeZone({ timezone: timeZone }));
  } catch (error) {
    if (error instanceof DropCreateValidationError) throw error;
    if (/unknown timezone/.test(error?.message || "")) {
      throw new DropCreateValidationError(error.message);
    }
    throw new DropCreateValidationError("close time must be a valid date");
  }
}

function parseCloseTime(value, timeZone = DEFAULT_TIME_ZONE) {
  return withCreateValidation(() => {
    if (value == null || value === "") return null;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return null;
      return optionalTimestamp(parseCloseTimeString(text, timeZone), "close time");
    }
    return optionalTimestamp(value, "close time");
  });
}

function parseDropCreateInput(input = {}, options = {}) {
  return withCreateValidation(() => {
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    return {
      bottleName: requiredText(input.bottle, "bottle"),
      description: optionalText(input.description, "description"),
      price: optionalText(input.price, "price"),
      location: optionalText(input.store, "store"),
      bottleLimit: optionalBottleLimit(input.limit, "limit"),
      closeTime: parseCloseTime(input.closeTime, timeZone),
    };
  });
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

function formatJoinReply({ signup, position } = {}) {
  if (signup?.status === "allocated") {
    return `You're in (#${position})`;
  }
  if (signup?.status === "waitlist") {
    return `Waitlisted (#${position})`;
  }
  return "You're not currently signed up for this drop.";
}

function formatDropClosedReply(status) {
  if (status === "canceled") {
    return "This drop was canceled.";
  }
  return "This drop is closed.";
}

function discordTimestamp(iso) {
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${seconds}:f> (<t:${seconds}:R>)`;
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
    .setFooter({ text: drop.status === "open" || !drop.status ? "Open" : drop.status });

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
  formatJoinReply,
  formatDropClosedReply,
  discordTimestamp,
  inButtonCustomId,
  parseInButtonCustomId,
  buildInButton,
  buildDropComponents,
  buildDropEmbed,
  buildDropMessage,
};
