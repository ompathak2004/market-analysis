import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HttpClient } from "../http.js";
import {
  COUNCIL_OF_MINISTERS_URL,
  displayName,
  LOK_SABHA_MEMBERS_URL,
  memberKey,
  ministerRank,
  ParliamentSource,
  parliamentSnapshot,
  parseCouncilOfMinisters,
  parseLokSabhaMembers,
  parseRajyaSabhaMembers,
  RAJYA_SABHA_MEMBERS_URL,
} from "./parliament.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("sansad parliament directory", () => {
  it("parses sitting Lok Sabha members and drops former ones", () => {
    const members = parseLokSabhaMembers(fixture("sansad-ls-members.json"));
    expect(members.map((m) => m.memberId)).toEqual(["5814", "4589"]);
    expect(members[1]).toMatchObject({
      house: "lok_sabha",
      name: "Narendra Modi",
      partyCode: "BJP",
      constituency: "Varanasi",
    });
  });

  it("parses Rajya Sabha members with term dates", () => {
    const members = parseRajyaSabhaMembers(fixture("sansad-rs-members.json"));
    expect(members).toHaveLength(2);
    const athawale = members.find((m) => m.memberId === "2248");
    expect(athawale).toMatchObject({
      house: "rajya_sabha",
      name: "Ramdas Bandu Athawale",
      fromDate: "2026-04-03",
      toDate: "2032-04-02",
    });
  });

  it("ranks the council of ministers", () => {
    const ministers = parseCouncilOfMinisters(fixture("sansad-council-of-ministers.json"));
    expect(ministers.map((m) => [m.memberId, m.house, m.rank, m.name])).toEqual([
      ["4589", "lok_sabha", "prime_minister", "Narendra Modi"],
      ["4268", "lok_sabha", "cabinet_minister", "Rajnath Singh"],
      ["2248", "rajya_sabha", "minister_of_state", "Ramdas Bandu Athawale"],
    ]);
    expect(ministerRank("Minister of State (Independent Charge)")).toBe("minister_of_state");
    expect(displayName("Athawale, Shri Ramdas Bandu")).toBe("Ramdas Bandu Athawale");
  });

  it("builds a per-house snapshot with a span per member and minister", () => {
    const dir = {
      members: [
        ...parseLokSabhaMembers(fixture("sansad-ls-members.json")),
        ...parseRajyaSabhaMembers(fixture("sansad-rs-members.json")),
      ],
      ministers: parseCouncilOfMinisters(fixture("sansad-council-of-ministers.json")),
    };
    const snap = parliamentSnapshot(dir, "lok_sabha");
    expect([...snap.spans.keys()].sort()).toEqual([
      "ls:4589",
      "ls:5814",
      "minister:ls:4268",
      "minister:ls:4589",
    ]);
    const span = snap.spans.get(memberKey({ house: "lok_sabha", memberId: "4589" }));
    expect(span && JSON.parse(snap.content.slice(span.start, span.end)).name).toBe("Narendra Modi");
    expect(parliamentSnapshot(dir, "lok_sabha").content).toBe(snap.content);
  });

  it("fetches the three feeds and rejects an empty directory", async () => {
    const bodies: Record<string, string> = {
      [LOK_SABHA_MEMBERS_URL]: fixture("sansad-ls-members.json"),
      [RAJYA_SABHA_MEMBERS_URL]: fixture("sansad-rs-members.json"),
      [COUNCIL_OF_MINISTERS_URL]: fixture("sansad-council-of-ministers.json"),
    };
    const http = {
      get: async (url: string) => ({ status: 200, text: () => bodies[url] ?? "[]" }),
    } as unknown as HttpClient;
    const dir = await new ParliamentSource(http).directory();
    expect(dir.members).toHaveLength(4);
    expect(dir.ministers).toHaveLength(3);
    bodies[RAJYA_SABHA_MEMBERS_URL] = JSON.stringify({ records: [] });
    await expect(new ParliamentSource(http).directory()).rejects.toThrow(/empty/);
  });
});
