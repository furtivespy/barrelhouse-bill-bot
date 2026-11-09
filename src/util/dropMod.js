import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import { DropValidationError, PICKUP_STATUSES } from "../db/drops.js";
import { DROP_EMBED_COLOR } from "./dropPost.js";

const PICKUP_BUTTON_PREFIX = "drop:pickup:";
const MAX_PICKUP_BUTTON_USERS = 5;
const LIST_DESCRIPTION_LIMIT = 4000;
const DROP_MANAGE_DENIED = "You need the Manage Messages permission to use this drop command.";

const SIGNUP_CSV_HEADERS = Object.freeze([
  "section",
  "position",
  "user_id",
  "status",
  "pickup_status",
  "joined_at",
  "removed_by",
  "removed_at",
]);

function mention(userId) {
  return `<@${userId}>`;
}

function hasDropManagePermission(interaction) {
  const perms = interaction?.memberPermissions ?? interaction?.member?.permissions;
  if (!perms || typeof perms.has !== "function") return false;
  return Boolean(perms.has(PermissionsBitField.Flags.ManageMessages));
}

function readDropRef(interaction) {
  const value = interaction?.options?.getString?.("drop");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveModDrop(store, { guildId, channelId, dropRef } = {}) {
  if (!store || typeof store.listDrops !== "function") {
    throw new DropValidationError("Drop storage is not available.");
  }

  if (dropRef) {
    const byId = typeof store.getDrop === "function" ? store.getDrop(dropRef) : undefined;
    if (byId) {
      if (guildId && byId.guildId !== guildId) {
        throw new DropValidationError("That drop is not in this server.");
      }
      return byId;
    }

    const drops = store.listDrops({ guildId });
    const needle = dropRef.toLowerCase();
    const matches = drops.filter((drop) => drop.bottleName.toLowerCase() === needle);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new DropValidationError("Multiple drops match that name. Pass the drop id.");
    }
    throw new DropValidationError("That drop could not be found.");
  }

  const open = store.listDrops({ guildId, channelId, status: "open" });
  if (open.length === 1) return open[0];
  if (open.length > 1) {
    throw new DropValidationError(
      "Multiple open drops in this channel. Pass the drop option to choose one."
    );
  }

  const latest = store.listDrops({ guildId, channelId })[0];
  if (!latest) {
    throw new DropValidationError(
      "No drop found in this channel. Create one with /drop create or pass the drop option."
    );
  }
  return latest;
}

function rosterSections(signups = []) {
  return {
    allocated: signups.filter((row) => row.status === "allocated"),
    waitlist: signups.filter((row) => row.status === "waitlist"),
    removed: signups.filter((row) => row.status === "removed"),
  };
}

function formatPickupLabel(status) {
  if (status === "picked_up") return "picked up";
  if (status === "no_show") return "no-show";
  return "pending";
}

function formatModListDescription(signups, bottleLimit) {
  const { allocated, waitlist } = rosterSections(signups);
  const allocatedHeader =
    bottleLimit == null
      ? `**Allocated** (${allocated.length})`
      : `**Allocated** (${allocated.length}/${bottleLimit})`;
  const allocatedLines = allocated.map(
    (row, index) => `${index + 1}. ${mention(row.userId)} — ${formatPickupLabel(row.pickupStatus)}`
  );
  const waitlistLines = waitlist.map((row, index) => `${index + 1}. ${mention(row.userId)}`);

  const parts = [
    allocatedHeader,
    allocatedLines.length ? allocatedLines.join("\n") : "_None_",
    "",
    `**Waitlist** (${waitlist.length})`,
    waitlistLines.length ? waitlistLines.join("\n") : "_None_",
  ];
  let text = parts.join("\n");
  if (text.length > LIST_DESCRIPTION_LIMIT) {
    text = `${text.slice(0, LIST_DESCRIPTION_LIMIT - 48).trimEnd()}\n… Use /drop export for the full list.`;
  }
  return text;
}

function pickupButtonCustomId(dropId, userId, pickupStatus) {
  return `${PICKUP_BUTTON_PREFIX}${dropId}:${userId}:${pickupStatus}`;
}

function parsePickupButtonCustomId(customId) {
  if (typeof customId !== "string" || !customId.startsWith(PICKUP_BUTTON_PREFIX)) {
    return null;
  }
  const parts = customId.slice(PICKUP_BUTTON_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [dropId, userId, pickupStatus] = parts;
  if (!dropId || !userId || !PICKUP_STATUSES.includes(pickupStatus)) {
    return null;
  }
  return { dropId, userId, pickupStatus };
}

function buildPickupButtons(dropId, allocated = []) {
  const users = allocated.slice(0, MAX_PICKUP_BUTTON_USERS);
  return users.map((row, index) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(pickupButtonCustomId(dropId, row.userId, "picked_up"))
        .setLabel(`Picked up #${index + 1}`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(pickupButtonCustomId(dropId, row.userId, "no_show"))
        .setLabel(`No-show #${index + 1}`)
        .setStyle(ButtonStyle.Secondary)
    )
  );
}

function buildModListPayload(drop, signups = []) {
  const { allocated } = rosterSections(signups);
  const embed = new EmbedBuilder()
    .setTitle(drop.bottleName)
    .setColor(DROP_EMBED_COLOR)
    .setDescription(formatModListDescription(signups, drop.bottleLimit))
    .setFooter({
      text:
        allocated.length > MAX_PICKUP_BUTTON_USERS
          ? `${drop.status === "open" || !drop.status ? "Open" : drop.status} · Buttons mark the first ${MAX_PICKUP_BUTTON_USERS}. Use /drop pickup for others.`
          : drop.status === "open" || !drop.status
            ? "Open"
            : drop.status,
    });

  return {
    embeds: [embed],
    components: buildPickupButtons(drop.id, allocated),
  };
}

function escapeCsvField(value) {
  if (value == null) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function buildSignupCsv(signups = []) {
  const { allocated, waitlist, removed } = rosterSections(signups);
  const lines = [SIGNUP_CSV_HEADERS.join(",")];
  const append = (section, rows) => {
    for (const [index, row] of rows.entries()) {
      lines.push(
        [
          section,
          index + 1,
          row.userId,
          row.status,
          row.pickupStatus,
          row.joinedAt ?? "",
          row.removedBy ?? "",
          row.removedAt ?? "",
        ]
          .map(escapeCsvField)
          .join(",")
      );
    }
  };
  append("allocated", allocated);
  append("waitlist", waitlist);
  append("removed", removed);
  return `${lines.join("\r\n")}\r\n`;
}

function csvFilename(drop) {
  const slug =
    String(drop?.bottleName || "drop")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "drop";
  return `${slug}.csv`;
}

function formatRemoveReply(result) {
  if (result?.alreadyRemoved) {
    return `${mention(result.signup.userId)} is already off the list.`;
  }
  let text = `Removed ${mention(result.signup.userId)} from the list.`;
  if (result?.promoted) {
    text += ` ${mention(result.promoted.userId)} moved up from the waitlist.`;
  }
  return text;
}

function formatPickupReply(signup) {
  if (signup.pickupStatus === "no_show") {
    return `Marked ${mention(signup.userId)} as a no-show.`;
  }
  return `Marked ${mention(signup.userId)} as ${formatPickupLabel(signup.pickupStatus)}.`;
}

function dropAutocompleteChoices(drops, query = "") {
  const needle = String(query).trim().toLowerCase();
  return drops
    .filter((drop) => {
      if (!needle) return true;
      return (
        drop.bottleName.toLowerCase().includes(needle) || drop.id.toLowerCase().includes(needle)
      );
    })
    .slice(0, 25)
    .map((drop) => ({
      name: `${drop.bottleName} (${drop.status})`.slice(0, 100),
      value: drop.id,
    }));
}

export {
  DROP_MANAGE_DENIED,
  MAX_PICKUP_BUTTON_USERS,
  PICKUP_BUTTON_PREFIX,
  SIGNUP_CSV_HEADERS,
  buildModListPayload,
  buildPickupButtons,
  buildSignupCsv,
  csvFilename,
  dropAutocompleteChoices,
  escapeCsvField,
  formatModListDescription,
  formatPickupLabel,
  formatPickupReply,
  formatRemoveReply,
  hasDropManagePermission,
  parsePickupButtonCustomId,
  pickupButtonCustomId,
  readDropRef,
  resolveModDrop,
  rosterSections,
};
