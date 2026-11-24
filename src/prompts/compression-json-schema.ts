import { ObservationTypeEnum } from "../eval/schemas.js";

// Keep the transport schema small for constrained local runtimes. Zod
// validates the decoded result again before any persistence or indexing.
export const COMPRESSION_JSON_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "observation",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["type", "title", "subtitle", "facts", "narrative", "concepts", "files", "importance"],
      properties: {
        type: { type: "string", enum: [...ObservationTypeEnum.options] },
        title: { type: "string", minLength: 1, maxLength: 120 },
        subtitle: { type: "string" },
        facts: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        narrative: { type: "string", minLength: 10 },
        concepts: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
        importance: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
  },
} as const;
