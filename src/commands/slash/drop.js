import { randomUUID } from "node:crypto";
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
} from "../../util/dropPost.js";
import { resolveTimeZone } from "../../util/timeZone.js";

async function replyPrivately(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction?.deferred && typeof interaction.editReply === "function") {
    await interaction.editReply({ content });
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

  async button(interaction) {
    // Press allocation and live-count edits are FUR-122.
    await interaction.reply({
      content: "Sign-up handling is not available yet.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

export default Drop;
