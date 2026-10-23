import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { listJsFiles } from "../src/handlers/discover.js";
import { resolveDevGuildId } from "../src/handlers/slashcommands.js";

const SRC = path.join(import.meta.dir, "../src");
const ROOT = path.join(import.meta.dir, "..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const DATA_CONFIG_EXAMPLE = path.join(ROOT, "data/config.json.example");
const LOCAL_CONFIG_SAMPLE = path.join(ROOT, "config.json.sample");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const BUN_LOCK = path.join(ROOT, "bun.lock");
const BOT_JS = path.join(SRC, "bot.js");

const VOICE_FILES = [
  "src/commands/slash/voiceCreate.js",
  "src/events/voiceStateUpdate.js",
  "src/util/onDemandVoice.js",
  "tests/onDemandVoice.test.js",
  "tests/voiceStateUpdate.test.js",
  "tests/helpers/voiceFeature.js",
];

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
  test("does not keep the on-demand voice files", () => {
    const leftover = VOICE_FILES.filter((file) => fs.existsSync(path.join(ROOT, file)));
    expect(leftover).toEqual([]);
  });

  test("does not request GuildVoiceStates", () => {
    expect(fs.readFileSync(BOT_JS, "utf8")).not.toMatch(/GuildVoiceStates/);
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
    expect(example).not.toMatch(/STANCY_DATA_DIR/);
  });
});

describe("sample config", () => {
  test("required secrets are placeholders; optional ids are blank", () => {
    expect(fs.existsSync(DATA_CONFIG_EXAMPLE)).toBe(true);
    const volume = JSON.parse(fs.readFileSync(DATA_CONFIG_EXAMPLE, "utf8"));
    const local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_SAMPLE, "utf8"));

    for (const sample of [volume, local]) {
      expect(sample.token).toBe("REPLACE_ME_DISCORD_BOT_TOKEN");
      expect(sample.clientId).toBe("REPLACE_ME_DISCORD_APPLICATION_ID");
      expect(sample.devGuildId).toBe("");
      expect(sample.botOwnerId).toBe("");
      expect(sample.token).not.toMatch(/^[A-Za-z0-9._-]{50,}$/);
      expect(resolveDevGuildId(sample, {})).toBeNull();
    }

    expect(volume.environment).toBe("production");
    expect(local.environment).toBe("development");
  });
});

describe("package identity", () => {
  test("bun.lock workspace name matches package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    const lock = fs.readFileSync(BUN_LOCK, "utf8");
    expect(pkg.name).toBe("barrelhouse-bill-bot");
    expect(lock).toContain(`"name": "${pkg.name}"`);
    expect(lock).not.toContain("discord-bot-gwj");
  });
});
