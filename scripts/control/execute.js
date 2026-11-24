// `execute`: run a fixture through the real slash commands, button handlers,
// interaction router, and SQLite stores (`settings.sqlite`, `drops.sqlite`)
// in a temporary directory without talking to Discord.
//
// A fixture default-exports `async (ctx) => { ... }`. See scripts/control-fixtures/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Collection, MessageFlags, PermissionsBitField } from "discord.js";
import BunEnmap from "../../src/db/BunEnmap.js";
import DropStore from "../../src/db/drops.js";
import DropCloser from "../../src/util/dropCloser.js";
import permLevels from "../../src/config.permissionLevels.js";
import { buildLevelCache, permlevel } from "../../src/util/permissions.js";
import { DEFAULT_SETTINGS, getSettings, writeSettings } from "../../src/util/settings.js";
import { routeInteraction } from "../../src/handlers/interactionRouter.js";
import { loadCommands } from "./featureMap.js";

function isEphemeral(payload) {
  const flags = payload?.flags;
  if (Array.isArray(flags)) return flags.includes(MessageFlags.Ephemeral);
  if (typeof flags === "number" || typeof flags === "bigint") {
    return (BigInt(flags) & BigInt(MessageFlags.Ephemeral)) !== 0n;
  }
  return false;
}

function embedToText(embed) {
  const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed;
  if (!json) return null;
  const parts = [
    json.title,
    json.description,
    ...(json.fields || []).map((f) => `${f.name}: ${f.value}`),
    json.footer?.text,
  ].filter(Boolean);
  return parts.length ? parts.join(" | ") : null;
}

function summarizePayload(kind, payload) {
  const text = typeof payload === "string" ? payload : (payload?.content ?? null);
  return {
    kind,
    text,
    embeds: (payload?.embeds || []).map(embedToText).filter(Boolean),
    visibility: isEphemeral(payload) ? "ephemeral" : "public",
    components: payload?.components?.length ?? 0,
    files: payload?.files?.length ?? 0,
  };
}

function createLoggerCollector() {
  const logged = [];
  const push = (level) => (message) => {
    if (level !== "error" && level !== "warn") return;
    logged.push({
      level,
      message:
        message instanceof Error ? message.stack || message.message : String(message),
    });
  };
  return {
    logged,
    logger: {
      info() {},
      debug() {},
      cmd() {},
      ready() {},
      time() {},
      log(message, type) {
        if (type === "error" || type === "warn") push(type)(message);
      },
      warn: push("warn"),
      error: push("error"),
    },
  };
}

function createOptionBag(options = {}) {
  return {
    getSubcommand(required = true) {
      if (options.subcommand != null) return options.subcommand;
      if (required) throw new Error("No subcommand provided in fixture");
      return null;
    },
    getString(name) {
      return options.strings?.[name] ?? null;
    },
    getInteger(name) {
      return options.integers?.[name] ?? null;
    },
    getBoolean(name) {
      return options.booleans?.[name] ?? null;
    },
    getUser(name) {
      const value = options.users?.[name];
      if (!value) return null;
      return typeof value === "string"
        ? { id: value, tag: `${value}#0001`, displayAvatarURL: () => "https://example.com/u.png" }
        : value;
    },
    getFocused(full = false) {
      if (full) {
        return {
          name: options.focusedName ?? "drop",
          value: options.focusedValue ?? "",
        };
      }
      return options.focusedValue ?? "";
    },
  };
}

async function createSession(base = {}, sharedResults = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-bill-"));
  const settings = new BunEnmap({ name: "settings", cloneLevel: "deep", dataDir });
  const drops = new DropStore({ dataDir });
  const defaultSettings = { ...DEFAULT_SETTINGS, ...(base.defaultSettings || {}) };
  settings.ensure("default", defaultSettings);

  const messages = new Map();
  let nextMessageId = 1;
  const guildId = base.guildId || "guild-control-1";
  const channelId = base.channelId || "channel-control-1";

  const makeChannel = (cid) => ({
    id: cid,
    async send(payload) {
      const id = `msg-${nextMessageId++}`;
      const record = {
        id,
        channelId: cid,
        payload,
        edits: [],
        deleted: false,
        async edit(nextPayload) {
          record.payload = nextPayload;
          record.edits.push(summarizePayload("messageEdit", nextPayload));
          return record;
        },
        async delete() {
          record.deleted = true;
        },
      };
      messages.set(id, record);
      return record;
    },
    messages: {
      async fetch(id) {
        const record = messages.get(id);
        if (!record) throw new Error(`Unknown fake message ${id}`);
        return record;
      },
      async edit(id, nextPayload) {
        const record = messages.get(id);
        if (!record) throw new Error(`Unknown fake message ${id}`);
        return record.edit(nextPayload);
      },
    },
  });

  const channel = makeChannel(channelId);
  const channelsCache = new Collection([[channelId, channel]]);
  const guild = {
    id: guildId,
    ownerId: base.ownerId || "owner-1",
    roles: {
      cache: new Collection([
        ["role-mod", { id: "role-mod", name: defaultSettings.modRole }],
        ["role-admin", { id: "role-admin", name: defaultSettings.adminRole }],
      ]),
    },
  };
  const guildsCache = new Collection([[guildId, guild]]);

  const { logger, logged: sessionLogged } = createLoggerCollector();
  const client = {
    user: {
      id: "bot-control-1",
      tag: "BarrelhouseBill#0001",
      displayAvatarURL: () => "https://example.com/bill.png",
    },
    config: {
      timezone: "America/New_York",
      botOwnerId: base.botOwnerId || "owner-1",
      defaultSettings,
      ...(base.config || {}),
    },
    permLevels,
    levelCache: buildLevelCache(permLevels),
    settings,
    drops,
    logger,
    slash_commands: new Collection(),
    guilds: { cache: guildsCache },
    channels: {
      cache: channelsCache,
      async fetch(id) {
        return channelsCache.get(id) || null;
      },
    },
    permlevel(context) {
      return permlevel(this.permLevels, context);
    },
    getSettings(g) {
      return getSettings(this.settings, this.config.defaultSettings, g);
    },
    writeSettings(id, next) {
      return writeSettings(this.settings, id, next);
    },
  };
  client.dropCloser = new DropCloser(client);

  const commandList = await loadCommands();
  for (const entry of commandList) {
    const abs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", entry.source);
    const mod = await import(pathToFileURL(abs).href);
    const Command = mod.default || mod;
    client.slash_commands.set(entry.name, new Command(client));
  }

  function buildMember(actor = {}) {
    const roleIds = [];
    if (actor.mod ?? true) roleIds.push("role-mod");
    if (actor.admin ?? true) roleIds.push("role-admin");
    const permFlags = [];
    if (actor.manageMessages ?? actor.mod ?? true) {
      permFlags.push(PermissionsBitField.Flags.ManageMessages);
    }
    if (actor.admin ?? true) {
      permFlags.push(PermissionsBitField.Flags.Administrator);
    }
    return {
      id: actor.userId || "user-1",
      roles: {
        cache: new Collection(roleIds.map((id) => [id, { id }])),
      },
      permissions: new PermissionsBitField(permFlags),
    };
  }

  async function dispatch(kind, label, interactionInit) {
    const beforeLogLen = sessionLogged.length;
    const beforeMsgCount = messages.size;
    const replies = [];
    const autocomplete = [];
    let deferred = 0;

    const actor = interactionInit.actor || {};
    const userId = actor.userId || interactionInit.userId || "user-1";
    const interaction = {
      client,
      guildId,
      guild,
      channelId,
      channel,
      createdTimestamp: Date.now(),
      deferred: false,
      replied: false,
      user: {
        id: userId,
        tag: `${userId}#0001`,
        displayAvatarURL: () => "https://example.com/user.png",
      },
      member: buildMember({ ...actor, userId }),
      memberPermissions: buildMember({ ...actor, userId }).permissions,
      isCommand: () => kind === "command",
      isChatInputCommand: () => kind === "command",
      isButton: () => kind === "button",
      isAutocomplete: () => kind === "autocomplete",
      isAnySelectMenu: () => false,
      isModalSubmit: () => false,
      async deferReply(opts) {
        interaction.deferred = true;
        deferred += 1;
        return opts;
      },
      async reply(payload) {
        interaction.replied = true;
        replies.push(summarizePayload("reply", payload));
        return payload;
      },
      async editReply(payload) {
        replies.push(summarizePayload("editReply", payload));
        return payload;
      },
      async followUp(payload) {
        replies.push(summarizePayload("followUp", payload));
        return payload;
      },
      async update(payload) {
        interaction.replied = true;
        replies.push(summarizePayload("update", payload));
        return payload;
      },
      async respond(choices) {
        autocomplete.push(choices.map((c) => c.name ?? c));
      },
      ...interactionInit.extra,
    };

    const routeResult = await routeInteraction(client, interaction);
    const newMessages = [...messages.values()]
      .slice(beforeMsgCount)
      .map((m) => ({ id: m.id, ...summarizePayload("channelPost", m.payload) }));

    const summary = {
      label,
      handled: routeResult.handled,
      denied: Boolean(routeResult.denied),
      deferred,
      replies,
      posts: newMessages,
      autocomplete,
      logged: sessionLogged.slice(beforeLogLen),
    };
    sharedResults.push(summary);
    return summary;
  }

  return {
    client,
    drops,
    settings,
    messages,
    results: sharedResults,
    run(name, options = {}) {
      const cleanName = String(name).replace(/^\//, "");
      const label = [
        `/${cleanName}`,
        options.subcommand,
      ]
        .filter(Boolean)
        .join(" ");
      return dispatch("command", label, {
        actor: options.actor,
        userId: options.userId,
        extra: {
          commandName: cleanName,
          options: createOptionBag(options),
        },
      });
    },
    button(customId, options = {}) {
      const targetMsg = options.messageId ? messages.get(options.messageId) : undefined;
      return dispatch("button", `button ${customId}`, {
        actor: options.actor,
        userId: options.userId,
        extra: {
          customId,
          message: targetMsg,
        },
      });
    },
    autocomplete(name, options = {}) {
      const cleanName = String(name).replace(/^\//, "");
      return dispatch("autocomplete", `autocomplete /${cleanName}`, {
        actor: options.actor,
        userId: options.userId,
        extra: {
          commandName: cleanName,
          options: createOptionBag(options),
        },
      });
    },
    cleanup() {
      client.dropCloser.stop();
      settings.close();
      drops.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

async function runFixtureFile(file) {
  const abs = path.resolve(file);
  const mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}`);
  const fn = typeof mod === "function" ? mod : mod.default || mod.run;
  if (typeof fn !== "function") {
    throw new Error(`${file} must export an async function (ctx) => { ... }`);
  }
  const results = [];
  const sessions = [];
  const makeSession = async (base = {}) => {
    const s = await createSession(base, results);
    sessions.push(s);
    return s;
  };
  let defaultSession = null;
  const ensureDefault = async () => {
    if (!defaultSession) defaultSession = await makeSession();
    return defaultSession;
  };
  const ctx = {
    results,
    session: makeSession,
    async run(name, options) {
      return (await ensureDefault()).run(name, options);
    },
    async button(customId, options) {
      return (await ensureDefault()).button(customId, options);
    },
    async autocomplete(name, options) {
      return (await ensureDefault()).autocomplete(name, options);
    },
  };
  try {
    const returned = await fn(ctx);
    return { results, returned };
  } finally {
    for (const s of sessions) {
      s.cleanup();
    }
  }
}

function formatSummary(summary) {
  const lines = [summary.label];
  if (summary.denied) lines.push("  DENIED by permission check");
  if (summary.deferred) lines.push(`  deferred reply x${summary.deferred}`);
  for (const post of summary.posts) {
    lines.push(`  channel post ${post.id}: ${JSON.stringify(post.text)} [${post.components} component row(s)]`);
    for (const embed of post.embeds) {
      lines.push(`    embed: ${JSON.stringify(embed)}`);
    }
  }
  for (const reply of summary.replies) {
    const flag = reply.visibility === "ephemeral" ? " (ephemeral)" : "";
    const extras = [
      reply.components ? `${reply.components} component row(s)` : null,
      reply.files ? `${reply.files} file(s)` : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `  ${reply.kind}${flag}: ${JSON.stringify(reply.text)}${extras ? ` [${extras}]` : ""}`
    );
    for (const embed of reply.embeds) {
      lines.push(`    embed: ${JSON.stringify(embed)}`);
    }
  }
  for (const choices of summary.autocomplete) {
    lines.push(`  autocomplete: ${JSON.stringify(choices)}`);
  }
  for (const entry of summary.logged) {
    lines.push(`  LOGGED ${entry.level.toUpperCase()}: ${entry.message.split("\n")[0]}`);
  }
  return lines.join("\n");
}

function allText(results) {
  return results
    .flatMap((r) => [
      ...r.replies.flatMap((p) => [p.text, ...p.embeds]),
      ...r.posts.flatMap((p) => [p.text, ...p.embeds]),
    ])
    .filter(Boolean)
    .join("\n");
}

export { allText, createSession, formatSummary, runFixtureFile };
