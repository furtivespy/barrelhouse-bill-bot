const DEFAULT_TIME_ZONE = "America/New_York";

function assertValidTimeZone(timeZone) {
  try {
    Temporal.Now.zonedDateTimeISO(timeZone);
  } catch {
    throw new Error(`unknown timezone: ${timeZone}`);
  }
}

function resolveTimeZone(config = {}) {
  const raw = config?.timezone ?? config?.timeZone;
  if (raw == null || raw === "") return DEFAULT_TIME_ZONE;
  if (typeof raw !== "string") {
    throw new Error("timezone must be a string");
  }
  const timeZone = raw.trim();
  if (!timeZone) return DEFAULT_TIME_ZONE;
  assertValidTimeZone(timeZone);
  return timeZone;
}

function instantToIso(text) {
  return new Date(Temporal.Instant.from(text).epochMilliseconds).toISOString();
}

function zonedPlainToIso(plainIso, timeZone) {
  assertValidTimeZone(timeZone);
  const plain = Temporal.PlainDateTime.from(plainIso, { overflow: "reject" });
  const zoned = plain.toZonedDateTime(timeZone, { disambiguation: "reject" });
  return new Date(zoned.epochMilliseconds).toISOString();
}

export {
  DEFAULT_TIME_ZONE,
  assertValidTimeZone,
  resolveTimeZone,
  instantToIso,
  zonedPlainToIso,
};
