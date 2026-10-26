import { randomUUID } from "node:crypto";
import {
  AttachmentBuilder,
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} from "discord.js";
import SlashCommand from "../../base/SlashCommand.js";
import {
  DropNotFoundError,
  DropNotOpenError,
  DropValidationError,
  SignupNotFoundError,
} from "../../db/drops.js";
import {
  DROP_MANAGE_DENIED,
  buildModListPayload,
  buildSignupCsv,
  csvFilename,
  dropAutocompleteChoices,
  formatPickupReply,
  formatRemoveReply,
  hasDropManagePermission,
  parsePickupButtonCustomId,
  readDropRef,
  resolveModDrop,
} from "../../util/dropMod.js";
import {
  DROP_COMMAND_NAME,
  DropCreateValidationError,
  buildDropMessage,
  formatDropClosedReply,
  formatJoinReply,
  parseDropCreateInput,
  parseInButtonCustomId,
  readCreateOptions,
  signupCountsForDrop,
} from "../../util/dropPost.js";
import { resolveTimeZone } from "../../util/timeZone.js";

function addDropOption(subcommand) {
  return subcommand.addStringOption((option) =>
    option
      .setName("drop")
      .setDescription("Drop id or bottle name (defaults to this channel)")
      .setRequired(false)
      .setAutocomplete(true)
  );
}

async function replyPrivately(interaction, content, extras = {}) {
  const payload = { flags: MessageFlags.Ephemeral, ...extras };
  if (content != null && content !== "") {
    payload.content = content;
  }
  if (interaction?.deferred && typeof interaction.editReply === "function") {
    const edit = { ...extras };
    if (payload.content !== undefined) {
      edit.content = payload.content;
    }
    await interaction.editReply(edit);
    return;
  }
  if (interaction?.replied && typeof interaction.followUp === "function") {
    await interaction.followUp(payload);
    return;
  }
  if (typeof interaction?.reply === "function") {
    await interaction.reply(payload);
  }
}

async function deferPrivately(interaction) {
  if (!interaction.deferred && !interaction.replied && typeof interaction.deferReply === "function") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

function dropCommandErrorMessage(error) {
  if (error instanceof SignupNotFoundError) {
    return "That person is not on this drop.";
  }
  if (error instanceof DropValidationError || error instanceof DropNotFoundError) {
    return error.message;
  }
  return null;
}

async function tryReplyPrivately(interaction, content, logger) {
  try {
    await replyPrivately(interaction, content);
  } catch (error) {
    logger?.error(error, "drop create");
  }
}

async function postDropMessage(interaction, payload) {
  if (typeof interaction.channel?.send === "function") {
    if (!interaction.deferred && !interaction.replied && typeof interaction.deferReply === "function") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const posted = await interaction.channel.send(payload);
    if (!posted?.id) {
      throw new Error("channel send did not return a message id");
    }
    return { posted, via: "send" };
  }

  await interaction.reply(payload);
  if (typeof interaction.fetchReply !== "function") {
    throw new Error("Could not read the posted drop message.");
  }
  const posted = await interaction.fetchReply();
  if (!posted?.id) {
    throw new Error("Could not read the posted drop message.");
  }
  return { posted, via: "reply" };
}

async function deletePostedMessage(interaction, posted) {
  if (posted && typeof posted.delete === "function") {
    await posted.delete();
    return;
  }
  if (typeof interaction?.deleteReply === "function") {
    await interaction.deleteReply();
  }
}

class Drop extends SlashCommand {
  constructor(client) {
    super(client, {
      name: DROP_COMMAND_NAME,
      description: "Create and manage bottle drops",
      usage: "/drop create | list | remove | pickup | export",
      enabled: true,
      permLevel: "User",
    });
    this.data = new SlashCommandBuilder()
      .setName(this.help.name)
      .setDescription(this.help.description)
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
      .setDMPermission(false)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("create")
          .setDescription("Post a new bottle drop with an In button")
          .addStringOption((option) =>
            option
              .setName("bottle")
              .setDescription("Bottle name")
              .setRequired(true)
              .setMaxLength(100)
          )
          .addStringOption((option) =>
            option
              .setName("price")
              .setDescription("Price, e.g. $59.99")
              .setRequired(false)
              .setMaxLength(40)
          )
          .addStringOption((option) =>
            option
              .setName("store")
              .setDescription("Store or pickup location")
              .setRequired(false)
              .setMaxLength(100)
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("Bottle limit (omit for unlimited)")
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(1000)
          )
          .addStringOption((option) =>
            option
              .setName("close_time")
              .setDescription("Close time in the bot timezone, or ISO 8601 with Z/offset")
              .setRequired(false)
              .setMaxLength(40)
          )
          .addStringOption((option) =>
            option
              .setName("description")
              .setDescription("Optional tasting notes")
              .setRequired(false)
              .setMaxLength(600)
          )
      )
      .addSubcommand((subcommand) =>
        addDropOption(
          subcommand
            .setName("list")
            .setDescription("Show the allocated list and waitlist (mods only)")
        )
      )
      .addSubcommand((subcommand) =>
        addDropOption(
          subcommand
            .setName("remove")
            .setDescription("Remove someone from the list (mods only)")
            .addUserOption((option) =>
              option.setName("user").setDescription("Person to remove").setRequired(true)
            )
        )
      )
      .addSubcommand((subcommand) =>
        addDropOption(
          subcommand
            .setName("pickup")
            .setDescription("Mark someone picked up or no-show (mods only)")
            .addUserOption((option) =>
              option.setName("user").setDescription("Person to mark").setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("status")
                .setDescription("Pickup status")
                .setRequired(true)
                .addChoices(
                  { name: "Picked up", value: "picked_up" },
                  { name: "No-show", value: "no_show" },
                  { name: "Pending", value: "pending" }
                )
            )
        )
      )
      .addSubcommand((subcommand) =>
        addDropOption(
          subcommand
            .setName("export")
            .setDescription("Download a CSV of everyone on the drop (mods only)")
        )
      );
  }

  botTimeZone() {
    try {
      return resolveTimeZone(this.client?.config);
    } catch (error) {
      throw new DropCreateValidationError(error.message);
    }
  }

  async execute(interaction) {
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.reply({
        content: "Use /drop in a server channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options?.getSubcommand?.(false) || "create";
    if (subcommand === "create") {
      return this.executeCreate(interaction);
    }
    if (subcommand === "list") {
      return this.executeList(interaction);
    }
    if (subcommand === "remove") {
      return this.executeRemove(interaction);
    }
    if (subcommand === "pickup") {
      return this.executePickup(interaction);
    }
    if (subcommand === "export") {
      return this.executeExport(interaction);
    }

    await interaction.reply({
      content: "Unknown drop action.",
      flags: MessageFlags.Ephemeral,
    });
  }

  async executeCreate(interaction) {
    let fields;
    try {
      fields = parseDropCreateInput(readCreateOptions(interaction), {
        timeZone: this.botTimeZone(),
      });
    } catch (error) {
      if (error instanceof DropCreateValidationError) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    const store = this.client?.drops;
    if (!store || typeof store.createDrop !== "function") {
      await interaction.reply({
        content: "Drop storage is not available.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.user?.id) {
      await interaction.reply({
        content: "Could not determine who created this drop.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const draft = {
      id: randomUUID(),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      createdBy: interaction.user.id,
      status: "open",
      ...fields,
    };
    const payload = buildDropMessage(draft, {
      allocated: 0,
      waitlisted: 0,
      bottleLimit: draft.bottleLimit,
    });

    let posted;
    try {
      ({ posted } = await postDropMessage(interaction, payload));
    } catch (error) {
      this.client?.logger?.error(error, "drop create");
      try {
        await deletePostedMessage(interaction, posted);
      } catch (cleanupError) {
        this.client?.logger?.error(cleanupError, "drop create cleanup");
      }
      await tryReplyPrivately(interaction, "Could not post the drop.", this.client?.logger);
      return;
    }

    try {
      const drop = store.createDrop({
        ...draft,
        messageId: posted.id,
      });
      if (typeof interaction.channel?.send === "function") {
        await tryReplyPrivately(interaction, "Drop posted.", this.client?.logger);
      }
      return drop;
    } catch (error) {
      this.client?.logger?.error(error, "drop create");
      try {
        await deletePostedMessage(interaction, posted);
      } catch (cleanupError) {
        this.client?.logger?.error(cleanupError, "drop create cleanup");
      }

      const message =
        error instanceof DropValidationError || error instanceof DropCreateValidationError
          ? error.message
          : "Could not save the drop. The post was removed.";
      await tryReplyPrivately(interaction, message, this.client?.logger);
    }
  }

  requireDropStore() {
    const store = this.client?.drops;
    if (!store) {
      throw new DropValidationError("Drop storage is not available.");
    }
    return store;
  }

  resolveCommandDrop(interaction) {
    return resolveModDrop(this.requireDropStore(), {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      dropRef: readDropRef(interaction),
    });
  }

  async denyUnlessDropManager(interaction) {
    if (hasDropManagePermission(interaction)) {
      return false;
    }
    await replyPrivately(interaction, DROP_MANAGE_DENIED);
    return true;
  }

  async executeList(interaction) {
    if (await this.denyUnlessDropManager(interaction)) {
      return;
    }

    try {
      const store = this.requireDropStore();
      const drop = this.resolveCommandDrop(interaction);
      const payload = buildModListPayload(drop, store.listSignups(drop.id));
      await replyPrivately(interaction, null, payload);
      return drop;
    } catch (error) {
      const message = dropCommandErrorMessage(error);
      if (message) {
        await replyPrivately(interaction, message);
        return;
      }
      throw error;
    }
  }

  async executeRemove(interaction) {
    if (await this.denyUnlessDropManager(interaction)) {
      return;
    }

    const target = interaction.options?.getUser?.("user");
    if (!target?.id) {
      await replyPrivately(interaction, "Choose a user to remove.");
      return;
    }
    if (!interaction.user?.id) {
      await replyPrivately(interaction, "Could not determine who is removing this person.");
      return;
    }

    await deferPrivately(interaction);

    try {
      const store = this.requireDropStore();
      const drop = this.resolveCommandDrop(interaction);
      const result = store.removeSignup(drop.id, target.id, { removedBy: interaction.user.id });
      await replyPrivately(interaction, formatRemoveReply(result));
      await this.updatePostedDrop(interaction, result.drop);
      return result;
    } catch (error) {
      const message = dropCommandErrorMessage(error);
      if (message) {
        await replyPrivately(interaction, message);
        return;
      }
      throw error;
    }
  }

  async executePickup(interaction) {
    if (await this.denyUnlessDropManager(interaction)) {
      return;
    }

    const target = interaction.options?.getUser?.("user");
    const status = interaction.options?.getString?.("status");
    if (!target?.id) {
      await replyPrivately(interaction, "Choose a user to mark.");
      return;
    }

    await deferPrivately(interaction);

    try {
      const store = this.requireDropStore();
      const drop = this.resolveCommandDrop(interaction);
      const result = store.setPickupStatus(drop.id, target.id, status);
      await replyPrivately(interaction, formatPickupReply(result.signup));
      return result;
    } catch (error) {
      const message = dropCommandErrorMessage(error);
      if (message) {
        await replyPrivately(interaction, message);
        return;
      }
      throw error;
    }
  }

  async executeExport(interaction) {
    if (await this.denyUnlessDropManager(interaction)) {
      return;
    }

    try {
      const store = this.requireDropStore();
      const drop = this.resolveCommandDrop(interaction);
      const csv = buildSignupCsv(store.listSignups(drop.id));
      const file = new AttachmentBuilder(Buffer.from(csv, "utf8"), { name: csvFilename(drop) });
      await replyPrivately(interaction, `CSV for ${drop.bottleName}.`, { files: [file] });
      return drop;
    } catch (error) {
      const message = dropCommandErrorMessage(error);
      if (message) {
        await replyPrivately(interaction, message);
        return;
      }
      throw error;
    }
  }

  async autocomplete(interaction) {
    const focused = interaction.options?.getFocused?.(true);
    if (focused?.name !== "drop") {
      if (typeof interaction.respond === "function") {
        await interaction.respond([]);
      }
      return;
    }

    const store = this.client?.drops;
    const drops =
      store && typeof store.listDrops === "function"
        ? store.listDrops({ guildId: interaction.guildId })
        : [];
    if (typeof interaction.respond === "function") {
      await interaction.respond(dropAutocompleteChoices(drops, focused.value));
    }
  }

  async handlePickupButton(interaction, pickup) {
    if (await this.denyUnlessDropManager(interaction)) {
      return;
    }

    const store = this.client?.drops;
    if (!store || typeof store.setPickupStatus !== "function") {
      await replyPrivately(interaction, "Drop storage is not available.");
      return;
    }

    await deferPrivately(interaction);

    try {
      const drop = typeof store.getDrop === "function" ? store.getDrop(pickup.dropId) : undefined;
      if (!drop) {
        await replyPrivately(interaction, "That drop could not be found.");
        return;
      }
      if (drop.guildId !== interaction.guildId) {
        await replyPrivately(interaction, "That drop is not in this server.");
        return;
      }

      const result = store.setPickupStatus(pickup.dropId, pickup.userId, pickup.pickupStatus);
      const payload = buildModListPayload(result.drop, store.listSignups(result.drop.id));
      if (typeof interaction.update === "function" && !interaction.deferred && !interaction.replied) {
        await interaction.update(payload);
        return result;
      }
      await replyPrivately(interaction, formatPickupReply(result.signup), payload);
      return result;
    } catch (error) {
      const message = dropCommandErrorMessage(error);
      if (message) {
        await replyPrivately(interaction, message);
        return;
      }
      throw error;
    }
  }

  async updatePostedDrop(interaction, drop) {
    const counts = signupCountsForDrop(this.client?.drops, drop);
    const payload = buildDropMessage(drop, counts);
    try {
      if (typeof interaction?.message?.edit === "function") {
        await interaction.message.edit(payload);
        return;
      }
      if (drop.messageId && typeof interaction?.channel?.messages?.edit === "function") {
        await interaction.channel.messages.edit(drop.messageId, payload);
        return;
      }
      this.client?.logger?.error(
        new Error("no message.edit path for drop sign-up count"),
        "drop in count update"
      );
    } catch (error) {
      this.client?.logger?.error(error, "drop in count update");
    }
  }

  async button(interaction) {
    const pickup = parsePickupButtonCustomId(interaction.customId);
    if (pickup) {
      return this.handlePickupButton(interaction, pickup);
    }

    const dropId = parseInButtonCustomId(interaction.customId);
    if (!dropId) {
      await replyPrivately(interaction, "Unknown drop action.");
      return;
    }

    if (!interaction.user?.id) {
      await replyPrivately(interaction, "Could not determine who pressed In.");
      return;
    }

    const store = this.client?.drops;
    if (!store || typeof store.joinSignup !== "function") {
      await replyPrivately(interaction, "Drop storage is not available.");
      return;
    }

    await deferPrivately(interaction);

    let result;
    try {
      result = store.joinSignup(dropId, interaction.user.id);
    } catch (error) {
      if (error instanceof DropNotFoundError) {
        await replyPrivately(interaction, "That drop could not be found.");
        return;
      }
      if (error instanceof DropNotOpenError) {
        await replyPrivately(interaction, formatDropClosedReply(error.dropStatus));
        return;
      }
      throw error;
    }

    await replyPrivately(interaction, formatJoinReply(result));
    await this.updatePostedDrop(interaction, result.drop);
    return result;
  }
}

export default Drop;
