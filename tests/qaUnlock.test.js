import { describe, expect, test } from "bun:test";
import { PermissionsBitField } from "discord.js";
import {
  QA_UNLOCK_ADMIN_COMMANDS,
  commandRegistrationPayload,
  isQaUnlockAdminCommands,
  shouldBypassAdministratorPermLevel,
  stripAdministratorDefaultMemberPermissions,
} from "../src/util/qaUnlock.js";

const ADMINISTRATOR = String(PermissionsBitField.Flags.Administrator);
const MANAGE_MESSAGES = String(PermissionsBitField.Flags.ManageMessages);

describe("isQaUnlockAdminCommands", () => {
  test("is off when the env var is unset, empty, or 0", () => {
    expect(isQaUnlockAdminCommands({})).toBe(false);
    expect(isQaUnlockAdminCommands({ [QA_UNLOCK_ADMIN_COMMANDS]: "" })).toBe(false);
    expect(isQaUnlockAdminCommands({ [QA_UNLOCK_ADMIN_COMMANDS]: "   " })).toBe(false);
    expect(isQaUnlockAdminCommands({ [QA_UNLOCK_ADMIN_COMMANDS]: "0" })).toBe(false);
    expect(isQaUnlockAdminCommands({ [QA_UNLOCK_ADMIN_COMMANDS]: "false" })).toBe(false);
  });

  test("is on when the env var is 1", () => {
    expect(isQaUnlockAdminCommands({ [QA_UNLOCK_ADMIN_COMMANDS]: "1" })).toBe(true);
    expect(isQaUnlockAdminCommands({ [QA_UNLOCK_ADMIN_COMMANDS]: "true" })).toBe(true);
  });
});

describe("stripAdministratorDefaultMemberPermissions", () => {
  test("clears Administrator-only defaultMemberPermissions", () => {
    const json = { default_member_permissions: ADMINISTRATOR };
    stripAdministratorDefaultMemberPermissions(json);
    expect(json.default_member_permissions).toBeNull();
  });

  test("leaves ManageMessages and other non-admin gates alone", () => {
    const json = { default_member_permissions: MANAGE_MESSAGES };
    stripAdministratorDefaultMemberPermissions(json);
    expect(json.default_member_permissions).toBe(MANAGE_MESSAGES);
  });

  test("removes only the Administrator bit from a combined permission", () => {
    const combined = String(
      PermissionsBitField.Flags.Administrator | PermissionsBitField.Flags.ManageMessages
    );
    const json = { default_member_permissions: combined };
    stripAdministratorDefaultMemberPermissions(json);
    expect(json.default_member_permissions).toBe(MANAGE_MESSAGES);
  });
});

describe("commandRegistrationPayload", () => {
  test("strips Administrator when unlocked and leaves the builder unchanged", () => {
    const command = {
      data: {
        toJSON() {
          return { name: "settings", default_member_permissions: ADMINISTRATOR };
        },
      },
    };

    const unlocked = commandRegistrationPayload(command, true);
    const locked = commandRegistrationPayload(command, false);

    expect(unlocked.default_member_permissions).toBeNull();
    expect(locked.default_member_permissions).toBe(ADMINISTRATOR);
    expect(command.data.toJSON().default_member_permissions).toBe(ADMINISTRATOR);
  });
});

describe("shouldBypassAdministratorPermLevel", () => {
  test("bypasses only Administrator commands when unlocked", () => {
    expect(
      shouldBypassAdministratorPermLevel({ conf: { permLevel: "Administrator" } }, true)
    ).toBe(true);
    expect(
      shouldBypassAdministratorPermLevel({ conf: { permLevel: "Administrator" } }, false)
    ).toBe(false);
    expect(
      shouldBypassAdministratorPermLevel({ conf: { permLevel: "Moderator" } }, true)
    ).toBe(false);
    expect(shouldBypassAdministratorPermLevel({ conf: { permLevel: "User" } }, true)).toBe(
      false
    );
  });
});
