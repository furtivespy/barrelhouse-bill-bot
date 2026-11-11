import Event from "../base/Event.js";
import EventTypes from "../base/EventTypes.js";

class Ready extends Event {
  constructor(client) {
    super(client, {
      name: "ready",
      eventType: EventTypes.READY,
      description: "Logged when the Discord client is ready.",
      enabled: true,
      once: true,
    });
  }

  async run() {
    try {
      if (this.client.application?.fetch) {
        this.client.appInfo = await this.client.application.fetch();
      }
    } catch (error) {
      this.client.logger?.error(error, "ready.js");
    }
    try {
      if (typeof this.client.dropCloser?.reschedulePending === "function") {
        await this.client.dropCloser.reschedulePending();
      }
    } catch (error) {
      this.client.logger?.error(error, "ready.js drop closer");
    }
    this.client.logger.ready("Ready!");
  }
}

export default Ready;
