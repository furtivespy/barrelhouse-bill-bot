import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TIME_ZONE,
  instantToIso,
  resolveTimeZone,
  zonedPlainToIso,
} from "../src/util/timeZone.js";

describe("bot timezone", () => {
  test("defaults to America/New_York and accepts a configured IANA zone", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/New_York");
    expect(resolveTimeZone()).toBe("America/New_York");
    expect(resolveTimeZone({})).toBe("America/New_York");
    expect(resolveTimeZone({ timezone: "" })).toBe("America/New_York");
    expect(resolveTimeZone({ timezone: "  UTC  " })).toBe("UTC");
    expect(resolveTimeZone({ timeZone: "America/Chicago" })).toBe("America/Chicago");
    expect(() => resolveTimeZone({ timezone: "Syracuse" })).toThrow(/unknown timezone: Syracuse/);
    expect(() => resolveTimeZone({ timezone: 12 })).toThrow(/timezone must be a string/);
  });

  test("converts offset-less wall times in the given zone independently of host TZ", () => {
    expect(zonedPlainToIso("2026-10-24T18:00", "America/New_York")).toBe(
      "2026-10-24T22:00:00.000Z"
    );
    expect(zonedPlainToIso("2026-01-15T18:00:00", "America/New_York")).toBe(
      "2026-01-15T23:00:00.000Z"
    );
    expect(instantToIso("2026-10-24T18:00:00Z")).toBe("2026-10-24T18:00:00.000Z");
    expect(instantToIso("2026-10-24T18:00:00+0500")).toBe("2026-10-24T13:00:00.000Z");
  });
});
