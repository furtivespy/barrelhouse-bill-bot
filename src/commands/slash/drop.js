import {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} from "discord.js";
import SlashCommand from "../../base/SlashCommand.js";
import { DropValidationError } from "../../db/drops.js";
import {
  DROP_COMMAND_NAME,
  DropCreateValidationError,
  buildDropMessage,
  parseDropCreateInput,
  readCreateOptions,
  signupCountsForDrop,
} from "../../util/dropPost.js";

class Drop extends SlashCommand {
  constructor(client) {
    super(client, {
      name: DROP_COMMAND_NAME,
      description: "Create and manage bottle drops",
      usage: "/drop create",
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
              .setDescription("ISO 8601 close time, e.g. 2026-10-24T18:00:00Z")
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
      );
  }

  async execute(interaction) {
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.reply({
        content: "Use /drop create in a server channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options?.getSubcommand?.(false);
    if (subcommand && subcommand !== "create") {
      await interaction.reply({
        content: "Unknown drop action.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let fields;
    try {
      fields = parseDropCreateInput(readCreateOptions(interaction));
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

    let drop;
    try {
      drop = store.createDrop({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        createdBy: interaction.user?.id,
        ...fields,
      });
    } catch (error) {
      if (error instanceof DropValidationError || error instanceof DropCreateValidationError) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    const counts = signupCountsForDrop(store, drop);
    await interaction.reply(buildDropMessage(drop, counts));

    if (typeof interaction.fetchReply !== "function") {
      return drop;
    }

    try {
      const posted = await interaction.fetchReply();
      if (posted?.id) {
        drop = store.updateDrop(drop.id, { messageId: posted.id });
      }
    } catch (error) {
      this.client?.logger?.error(error, "drop create");
    }

    return drop;
  }

  async button(interaction) {
    // Press allocation and live-count edits are FUR-122.
    await interaction.reply({
      content: "Sign-up handling is not available yet.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

export default Drop;
