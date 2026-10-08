import { z } from "zod";

export type JsonSchema = { [key: string]: unknown };

export function toStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema, "$");
}

function convert(s: z.ZodTypeAny, path: string): JsonSchema {
  const description = s.description ? { description: s.description } : {};
  if (s instanceof z.ZodDefault) return { ...convert(s._def.innerType, path), ...description };
  if (s instanceof z.ZodEffects) return { ...convert(s._def.schema, path), ...description };
  if (s instanceof z.ZodBranded) return convert(s._def.type, path);
  if (s instanceof z.ZodReadonly) return convert(s._def.innerType, path);
  if (s instanceof z.ZodNullable) {
    return { anyOf: [convert(s._def.innerType, path), { type: "null" }], ...description };
  }
  if (s instanceof z.ZodOptional) {
    throw new Error(`strict json schema cannot express optional field at ${path}; use nullable`);
  }
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const keys = Object.keys(shape);
    return {
      type: "object",
      properties: Object.fromEntries(
        keys.map((k) => [k, convert(shape[k] as z.ZodTypeAny, `${path}.${k}`)]),
      ),
      required: keys,
      additionalProperties: false,
      ...description,
    };
  }
  if (s instanceof z.ZodArray) {
    return { type: "array", items: convert(s.element, `${path}[]`), ...description };
  }
  if (s instanceof z.ZodString) return { type: "string", ...description };
  if (s instanceof z.ZodNumber) {
    const out: JsonSchema = { type: s.isInt ? "integer" : "number" };
    for (const check of s._def.checks) {
      if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
      if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
    }
    return { ...out, ...description };
  }
  if (s instanceof z.ZodBoolean) return { type: "boolean", ...description };
  if (s instanceof z.ZodNull) return { type: "null", ...description };
  if (s instanceof z.ZodEnum) return { type: "string", enum: [...s.options], ...description };
  if (s instanceof z.ZodNativeEnum) {
    return { enum: Object.values(s.enum as Record<string, string | number>), ...description };
  }
  if (s instanceof z.ZodLiteral) return { const: s.value, ...description };
  if (s instanceof z.ZodUnion) {
    return {
      anyOf: (s.options as z.ZodTypeAny[]).map((o, i) => convert(o, `${path}|${i}`)),
      ...description,
    };
  }
  throw new Error(`unsupported zod type ${s._def.typeName as string} at ${path}`);
}
