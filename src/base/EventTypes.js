import { Events } from "discord.js";

const EventTypes = {
  READY: Events.ClientReady,
  INTERACTION_CREATE: Events.InteractionCreate,
  // Optional Discord event names. Unused unless a matching file exists under src/events.
  MESSAGE_REACTION_ADD: Events.MessageReactionAdd,
  MESSAGE_REACTION_REMOVE: Events.MessageReactionRemove,
};

export default EventTypes;
