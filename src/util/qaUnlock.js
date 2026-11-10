import { PermissionsBitField } from "discord.js";
import { commandPermLevelName, isEnabledFlag } from "./permissions.js";

const QA_UNLOCK_ADMIN_COMMANDS = "QA_UNLOCK_ADMIN_COMMANDS";
const ADMINISTRATOR_BITS = BigInt(PermissionsBitField.Flags.Administrator);

function isQaUnlockAdminCommands(env = process.env) {
  const raw = env.QA_UNLOCK_ADMIN_COMMANDS;
  if (raw == null || String(raw).trim() === "") return false;
  return isEnabledFlag(raw, false);
}

function parsePermissionBits(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function stripAdministratorDefaultMemberPermissions(json) {
  if (!json || typeof json !== "object") return json;
  const bits = parsePermissionBits(json.default_member_permissions);
  if (bits == null) return json;
  if ((bits & ADMINISTRATOR_BITS) === 0n) return json;
  const remaining = bits & ~ADMINISTRATOR_BITS;
  json.default_member_permissions = remaining === 0n ? null : String(remaining);
  return json;
}

function commandRegistrationPayload(command, unlockAdminCommands) {
  const json = typeof command?.data?.toJSON === "function" ? command.data.toJSON() : {};
  if (unlockAdminCommands) {
    stripAdministratorDefaultMemberPermissions(json);
  }
  return json;
}

function shouldBypassAdministratorPermLevel(command, unlocked) {
  return Boolean(unlocked) && commandPermLevelName(command) === "Administrator";
}

export {
  QA_UNLOCK_ADMIN_COMMANDS,
  isQaUnlockAdminCommands,
  stripAdministratorDefaultMemberPermissions,
  commandRegistrationPayload,
  shouldBypassAdministratorPermLevel,
};
