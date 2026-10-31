import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_LONG_HAUL_MILES, toolSchemas } from "./tool-schemas.js";

const schema = toolSchemas.get_long_haul_share;
const parse = (thresholdMiles: unknown) => schema.safeParse({ code: "anc", thresholdMiles });

describe("get_long_haul_share thresholdMiles", () => {
  it.each([250, 500, 2500])("accepts %d", (v) => {
    const res = parse(v);
    expect(res.success).toBe(true);
    expect(res.data?.thresholdMiles).toBe(v);
  });

  it.each([-100, 251, 2750, 99999, 500.5, 0, "500", null])("rejects %s", (v) => {
    expect(parse(v).success).toBe(false);
  });

  it("explains the multiple-of-250 rule", () => {
    const res = parse(251);
    expect(res.success).toBe(false);
    expect(z.prettifyError(res.error!)).toMatch(/multiple of 250/);
  });

  it("is optional: omitted stays undefined so the service applies its default", () => {
    const res = schema.safeParse({ code: "anc" });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ code: "ANC" });
    expect(DEFAULT_LONG_HAUL_MILES).toBe(2500);
  });

  it("carries the restriction into the JSON Schema sent to OpenAI", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(json.properties.thresholdMiles).toMatchObject({
      type: "integer",
      minimum: 250,
      maximum: 2500,
      multipleOf: 250,
    });
    expect(json.required).toEqual(["code"]);
  });
});
