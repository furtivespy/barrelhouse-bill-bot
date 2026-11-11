import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import {
  DropValidationError,
  countSignups,
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
const ALLOCATED_FIELD_LIMIT = 1024;
const ALLOCATED_TRUNCATION = "\n… Use /drop list for the full list.";

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

function formatDropStatus(status) {
  if (status === "closed") return "Closed";
  if (status === "canceled") return "Canceled";
  return "Open";
}

function formatDropSettleReply(action, status) {
  if (action === "close" && status === "closed") {
    return "That drop is already closed.";
  }
  if (action === "cancel" && status === "canceled") {
    return "That drop is already canceled.";
  }
  if (status === "canceled") {
    return "That drop was canceled.";
  }
  if (status === "closed") {
    return "That drop is already closed.";
  }
  return `That drop is ${status}.`;
}

function formatAllocatedList(signups = []) {
  const allocated = signups.filter((row) => row?.status === "allocated");
  if (!allocated.length) return "_None_";
  const lines = allocated.map((row, index) => `${index + 1}. <@${row.userId}>`);
  const text = lines.join("\n");
  if (text.length <= ALLOCATED_FIELD_LIMIT) return text;

  const budget = ALLOCATED_FIELD_LIMIT - ALLOCATED_TRUNCATION.length;
  const kept = [];
  let size = 0;
  for (const line of lines) {
    const extra = kept.length === 0 ? line.length : line.length + 1;
    if (size + extra > budget) break;
    kept.push(line);
    size += extra;
  }
  if (kept.length === 0) return ALLOCATED_TRUNCATION.trim();
  return `${kept.join("\n")}${ALLOCATED_TRUNCATION}`;
}

function formatDropPostUpdateReply({ action, alreadySettled, posted, status }) {
  if (alreadySettled) {
    const settle = formatDropSettleReply(action, status);
    return posted ? settle : `${settle} The post could not be updated.`;
  }
  if (action === "close") {
    return posted
      ? "Drop closed. Final allocated list posted."
      : "Drop closed, but the post could not be updated. Try /drop close again.";
  }
  return posted
    ? "Drop canceled."
    : "Drop canceled, but the post could not be updated. Try /drop cancel again.";
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

function buildInButton(dropId, { disabled = false } = {}) {
  return new ButtonBuilder()
    .setCustomId(inButtonCustomId(dropId))
    .setLabel("In")
    .setStyle(ButtonStyle.Success)
    .setDisabled(Boolean(disabled));
}

function buildDropComponents(dropId, { disabled = false } = {}) {
  return [new ActionRowBuilder().addComponents(buildInButton(dropId, { disabled }))];
}

function buildDropEmbed(drop, counts = {}, { signups } = {}) {
  const signupCounts = {
    allocated: counts.allocated ?? 0,
    waitlisted: counts.waitlisted ?? 0,
    bottleLimit: counts.bottleLimit ?? drop.bottleLimit ?? null,
  };
  const embed = new EmbedBuilder()
    .setTitle(drop.bottleName)
    .setColor(DROP_EMBED_COLOR)
    .setFooter({ text: formatDropStatus(drop.status) });

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
  if (drop.status === "closed") {
    fields.push({
      name: "Allocated",
      value: formatAllocatedList(signups ?? []),
      inline: false,
    });
  }
  embed.addFields(fields);
  return embed;
}

function isDropOpen(drop) {
  return !drop?.status || drop.status === "open";
}

function buildDropMessage(drop, counts, { signups } = {}) {
  return {
    embeds: [buildDropEmbed(drop, counts, { signups })],
    components: buildDropComponents(drop.id, { disabled: !isDropOpen(drop) }),
  };
}

function buildStoredDropMessage(store, drop) {
  const resolved =
    drop?.id && typeof store?.getDrop === "function" ? store.getDrop(drop.id) || drop : drop;
  const signups = typeof store?.listSignups === "function" ? store.listSignups(resolved.id) : [];
  return buildDropMessage(
    resolved,
    {
      ...countSignups(signups),
      bottleLimit: resolved.bottleLimit ?? null,
    },
    { signups }
  );
}

async function editDropPost(client, drop, payload) {
  if (!drop?.messageId || !drop?.channelId) return false;
  const channels = client?.channels;
  if (!channels) return false;

  let channel = typeof channels.cache?.get === "function" ? channels.cache.get(drop.channelId) : null;
  if (!channel && typeof channels.fetch === "function") {
    channel = await channels.fetch(drop.channelId);
  }
  if (typeof channel?.messages?.edit !== "function") return false;
  await channel.messages.edit(drop.messageId, payload);
  return true;
}

export {
  ALLOCATED_FIELD_LIMIT,
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
  formatDropStatus,
  formatDropSettleReply,
  formatDropPostUpdateReply,
  formatAllocatedList,
  ALLOCATED_TRUNCATION,
  discordTimestamp,
  inButtonCustomId,
  parseInButtonCustomId,
  buildInButton,
  buildDropComponents,
  buildDropEmbed,
  buildDropMessage,
  buildStoredDropMessage,
  editDropPost,
  isDropOpen,
};
