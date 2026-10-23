import { describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import fs from "fs";
import path from "path";
import { listJsFiles } from "../src/handlers/discover.js";
import loadEvents from "../src/handlers/events.js";
import {
  loadSlashCommands,
  registerSlashCommands,
} from "../src/handlers/slashcommands.js";
import { routeInteraction } from "../src/handlers/interactionRouter.js";
import { DEFAULT_SETTINGS, getSettings, writeSettings } from "../src/util/settings.js";
import { memoryStore } from "./helpers/memoryStore.js";

const SRC = path.join(import.meta.dir, "../src");
const ROOT = path.join(import.meta.dir, "..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const DATA_CONFIG_EXAMPLE = path.join(ROOT, "data/config.json.example");

const CORE_COMMANDS = ["ping", "settings", "status"];
const CORE_EVENTS = ["interactionCreate", "ready"];

const VOICE_FILES = [
  "src/commands/slash/voiceCreate.js",
  "src/events/voiceStateUpdate.js",
  "src/util/onDemandVoice.js",
  "tests/onDemandVoice.test.js",
  "tests/voiceStateUpdate.test.js",
  "tests/helpers/voiceFeature.js",
];

function silentLogger() {
  return {
    info() {},
    error() {},
    warn() {},
    debug() {},
    cmd() {},
    ready() {},
    time() {},
    log() {},
  };
}

function fakeClient() {
  const registered = {};
  const store = memoryStore({ default: { ...DEFAULT_SETTINGS } });
  writeSettings(store, "guild-1", { modRole: "Staff" });
  return {
    logger: silentLogger(),
    slash_commands: new Collection(),
    events: new Collection(),
    config: { token: "t", clientId: "client-1", environment: "production" },
    user: {
      tag: "Bot#0000",
      displayAvatarURL: () => "https://cdn.example/bot.png",
    },
    guilds: { cache: { size: 2 } },
    settings: store,
    getSettings(guild) {
      return getSettings(store, DEFAULT_SETTINGS, guild);
    },
    writeSettings(id, next) {
      return writeSettings(store, id, next);
    },
    registered,
    on(name, handler) {
      registered[name] = { bind: "on", handler };
    },
    once(name, handler) {
      registered[name] = { bind: "once", handler };
    },
  };
}

function envVarsReferencedInSrc() {
  const names = new Set();
  const ident = /\b(?:env|process\.env)\.([A-Z][A-Z0-9_]+)/g;
  for (const file of listJsFiles(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = ident.exec(source))) names.add(match[1]);
  }
  return [...names].sort();
}

describe("voice feature removed", () => {
  test("does not keep the Stancy on-demand voice files", () => {
    const leftover = VOICE_FILES.filter((file) => fs.existsSync(path.join(ROOT, file)));
    expect(leftover).toEqual([]);
  });
});

describe("core slash commands", () => {
  test("loaders register /ping /status /settings and not /voice-create", async () => {
    const client = fakeClient();
    const commands = await loadSlashCommands(client);
    const events = await loadEvents(client);

    expect(commands.map((command) => command.data.name).sort()).toEqual(CORE_COMMANDS);
    expect(client.slash_commands.get("voice-create")).toBeUndefined();
    expect(events.map((loaded) => loaded.name).sort()).toEqual(CORE_EVENTS);
    expect(client.events.get("voiceStateUpdate")).toBeUndefined();
    expect(typeof client.registered.clientReady.handler).toBe("function");
    expect(client.registered.ready).toBeUndefined();
    expect(typeof client.registered.interactionCreate.handler).toBe("function");
    expect(client.registered.voiceStateUpdate).toBeUndefined();

    const puts = [];
    const result = await registerSlashCommands(client, commands, {
      rest: {
        async put(route, payload) {
          puts.push({ route, payload });
        },
      },
      env: { DEV_GUILD_ID: "999" },
    });
    expect(result).toEqual({ scope: "guild", guildId: "999", count: 3 });
    expect(puts[0].payload.body.map((cmd) => cmd.name).sort()).toEqual(CORE_COMMANDS);

    const pingReplies = [];
    const statusReplies = [];
    const settingsReplies = [];
    const chatInput = (commandName, replies, extras = {}) => ({
      isCommand: () => true,
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      isModalSubmit: () => false,
      deferred: false,
      replied: false,
      createdTimestamp: Date.now(),
      commandName,
      user: {
        id: "user-1",
        tag: "Tester#1234",
        displayAvatarURL: () => "https://cdn.example/user.jpg",
      },
      client,
      options: { getSubcommand: () => null },
      reply: async (payload) => {
        replies.push(payload);
      },
      ...extras,
    });
    await routeInteraction(client, chatInput("ping", pingReplies));
    await routeInteraction(client, chatInput("status", statusReplies));
    await routeInteraction(
      client,
      chatInput("settings", settingsReplies, {
        guildId: "guild-1",
        guild: { id: "guild-1" },
        options: { getSubcommand: () => "show", getString: () => null },
      })
    );
    expect(pingReplies[0].content).toBe("Pong!");
    expect(statusReplies[0].content).toContain("Version:");
    expect(statusReplies[0].content).toContain("Servers: 2");
    expect(settingsReplies[0].content).toContain("modRole: `Staff`");
  });
});

describe(".env.example", () => {
  test("lists every process env var the source reads", () => {
    expect(fs.existsSync(ENV_EXAMPLE)).toBe(true);
    const example = fs.readFileSync(ENV_EXAMPLE, "utf8");
    const referenced = envVarsReferencedInSrc();
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((name) => !example.includes(name));
    expect(missing).toEqual([]);
  });
});

describe("data volume sample config", () => {
  test("ships placeholders for token, client id, and guild/user ids", () => {
    expect(fs.existsSync(DATA_CONFIG_EXAMPLE)).toBe(true);
    const sample = JSON.parse(fs.readFileSync(DATA_CONFIG_EXAMPLE, "utf8"));
    expect(sample.token).toBe("REPLACE_ME_DISCORD_BOT_TOKEN");
    expect(sample.clientId).toBe("REPLACE_ME_DISCORD_APPLICATION_ID");
    expect(sample.devGuildId).toBe("REPLACE_ME_WILL_SERVER_GUILD_ID");
    expect(sample.botOwnerId).toBe("REPLACE_ME_WILL_DISCORD_USER_ID");
    expect(sample.environment).toBe("production");
    expect(sample.token).not.toMatch(/^[A-Za-z0-9._-]{50,}$/);
  });
});
