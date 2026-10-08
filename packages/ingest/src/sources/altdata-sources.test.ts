import { describe, expect, it } from "vitest";
import { normalizeAdsb } from "./adsb.js";
import { parseAircraftDb, parseFlags } from "./aircraft-db.js";
import { parseAisMessage, parseAisTime } from "./aisstream.js";

describe("normalizeAdsb", () => {
  it("normalizes hexes, ground state and position age", () => {
    const now = Date.parse("2026-10-01T10:00:00Z");
    const out = normalizeAdsb({
      now,
      ac: [
        {
          hex: "~80ABCD",
          r: "vt-akv",
          t: "b39m",
          alt_baro: "ground",
          gs: 4,
          lat: 19.09,
          lon: 72.87,
          seen_pos: 2,
        },
        {
          hex: "800001",
          flight: " AIC101 ",
          alt_baro: 36_012.4,
          gs: 450,
          track: 88,
          lat: 21,
          lon: 75,
        },
        { hex: "800002", alt_baro: 10_000 },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      hex: "80abcd",
      registration: "VT-AKV",
      icaoType: "B39M",
      onGround: true,
      altFt: null,
      callsign: null,
    });
    expect(out[0]?.ts.getTime()).toBe(now - 2_000);
    expect(out[1]).toMatchObject({ altFt: 36_012, onGround: false, callsign: "AIC101", track: 88 });
  });
});

describe("aircraft database", () => {
  it("reads the military, PIA and LADD flag bits", () => {
    expect(parseFlags("0001")).toEqual({ military: false, pia: false, ladd: true });
    expect(parseFlags("1010")).toEqual({ military: true, pia: true, ladd: false });
    expect(parseFlags("")).toEqual({ military: false, pia: false, ladd: false });
  });

  it("keeps only rows with the requested registration prefix and a valid hex", () => {
    const rows = parseAircraftDb(
      [
        "800c4b;VT-JSK;GLEX;0001;Bombardier Global 6000;;;",
        "a00001;N1;C172;0000;;;;",
        "zzzz;VT-BAD;;;;;",
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hex: "800c4b", registration: "VT-JSK" });
  });
});

describe("parseAisMessage", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  it("parses position reports and drops AIS sentinel values", () => {
    const msg = parseAisMessage(
      {
        MessageType: "PositionReport",
        MetaData: {
          MMSI: 419_000_123,
          ShipName: "DESH@@ BHAKT  ",
          time_utc: "2026-10-01 05:06:07.123 +0000 UTC",
        },
        Message: {
          PositionReport: {
            UserID: 419_000_123,
            Latitude: 22.4,
            Longitude: 69.7,
            Sog: 102.3,
            Cog: 360,
            TrueHeading: 511,
            NavigationalStatus: 1,
          },
        },
      },
      now,
    );
    expect(msg.kind).toBe("position");
    if (msg.kind !== "position") return;
    expect(msg.name).toBe("DESH BHAKT");
    expect(msg.position).toMatchObject({
      sogKt: null,
      cogDeg: null,
      headingDeg: null,
      navStatus: 1,
    });
    expect(msg.position.ts.toISOString()).toBe("2026-10-01T05:06:07.000Z");
  });

  it("parses static data with dimensions, draught and ETA", () => {
    const msg = parseAisMessage(
      {
        MessageType: "ShipStaticData",
        Message: {
          ShipStaticData: {
            UserID: 419_000_123,
            ImoNumber: 9_232_905,
            Name: "DESH BHAKT@@@",
            Type: 80,
            Dimension: { A: 200, B: 44, C: 20, D: 22 },
            MaximumStaticDraught: 14.2,
            Destination: "IN SIK",
            Eta: { Month: 10, Day: 3, Hour: 6, Minute: 0 },
          },
        },
      },
      now,
    );
    expect(msg.kind).toBe("static");
    if (msg.kind !== "static") return;
    expect(msg.static).toMatchObject({
      imo: 9_232_905,
      name: "DESH BHAKT",
      lengthM: 244,
      beamM: 42,
      draughtM: 14.2,
      destination: "IN SIK",
      eta: "10-03 06:00",
    });
  });

  it("recognizes confirmations, errors and unparsable times", () => {
    expect(parseAisMessage({ MessageType: "SubscriptionConfirmation" }).kind).toBe("confirm");
    expect(parseAisMessage({ error: "Api Key Is Not Valid" })).toEqual({
      kind: "error",
      error: "Api Key Is Not Valid",
    });
    expect(parseAisTime("garbage", now)).toBe(now);
  });
});
