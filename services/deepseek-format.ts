import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";

// DeepSeek rejects Zod's nullable anyOf without a top-level type.
// Normalize equivalent nullable unions while retaining the SDK parse callback.
export function deepSeekFormat<T extends z.ZodType>(schema: T, name: string) {
  const format = zodTextFormat(schema, name);
  function normalize(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(normalize);
    if (!node || typeof node !== "object") return node;
    if ("$ref" in node && typeof node.$ref === "string") {
      const target = node.$ref.slice(2).split("/").reduce<unknown>((value, key) => (value as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")], format.schema);
      return normalize(target);
    }
    const object = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, normalize(value)]));
    const union = object.anyOf as Array<Record<string, unknown>> | undefined;
    if (union?.length === 2 && union.some(x => x.type === "null")) {
      const value = union.find(x => x.type !== "null")!;
      if (typeof value.type === "string") {
        delete object.anyOf;
        Object.assign(object, value, { type: [value.type, "null"] });
        if (Array.isArray(value.enum)) object.enum = [...value.enum, null];
      }
    }
    return object;
  }
  format.schema = normalize(format.schema) as typeof format.schema;
  return format;
}
