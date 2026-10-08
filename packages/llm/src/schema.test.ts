import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toStrictJsonSchema } from "./schema.js";

describe("toStrictJsonSchema", () => {
  it("closes every object and requires every property", () => {
    const s = z.object({
      a: z.string().max(10),
      b: z.number().int().min(0).max(5),
      c: z.array(z.object({ d: z.enum(["x", "y"]), e: z.string().nullable() })).min(1),
      f: z.array(z.string()).default([]),
    });
    expect(toStrictJsonSchema(s)).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "integer", minimum: 0, maximum: 5 },
        c: {
          type: "array",
          items: {
            type: "object",
            properties: {
              d: { type: "string", enum: ["x", "y"] },
              e: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["d", "e"],
            additionalProperties: false,
          },
        },
        f: { type: "array", items: { type: "string" } },
      },
      required: ["a", "b", "c", "f"],
      additionalProperties: false,
    });
  });

  it("rejects optional fields that strict mode cannot express", () => {
    expect(() => toStrictJsonSchema(z.object({ a: z.string().optional() }))).toThrow(/optional/);
  });
});
