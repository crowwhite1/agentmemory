import type { MemoryProvider } from "../types.js";

const STRICTER_SUFFIX = `

IMPORTANT: Your previous response was invalid. Follow the required output format exactly. Every required field must be present with valid values.`;

const FIELD_HINTS: Record<string, string> = {
  type: "type: choose exactly one allowed type; use conversation for messages",
  title: "title: provide a nonempty title of at most 120 characters",
  subtitle: "subtitle: use a string",
  facts: "facts: provide at least one specific factual detail",
  narrative: "narrative: provide at least 10 characters",
  concepts: "concepts: use individual list entries in the required format",
  files: "files: use individual paths in the required format, or an empty list",
  importance: "importance: use an integer from 1 to 10",
};

function correction(errors?: string[]): string {
  const hints = new Set<string>();
  for (const error of errors ?? []) {
    if (error === "xml_parse_failed") {
      hints.add("Output only the required single complete object; use separate entries for lists, with no surrounding prose. Escape special characters as required by the format.");
      continue;
    }
    const field = /^([a-z]+)(?:\.\d+)*:/.exec(error)?.[1];
    if (field && Object.hasOwn(FIELD_HINTS, field)) hints.add(FIELD_HINTS[field]);
  }
  // Do not echo raw validation messages or model output; either can contain
  // secrets or untrusted instructions.
  return hints.size ? "\nCorrect these fields: " + [...hints].join("; ") + "." : "";
}

type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors?: string[] };

export async function compressWithRetry<T>(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  validator: (response: string) => ValidationResult<T>,
  maxRetries = 1,
): Promise<ValidationResult<T> & { retried: boolean }> {
  const first = await provider.compress(systemPrompt, userPrompt);
  let result = validator(first);
  if (result.valid) return { ...result, retried: false };

  let retried = false;
  for (let i = 0; i < maxRetries; i++) {
    retried = true;
    const retry = await provider.compress(
      systemPrompt + STRICTER_SUFFIX + correction(result.errors),
      userPrompt,
    );
    result = validator(retry);
    if (result.valid) return { ...result, retried };
  }

  return { ...result, retried };
}
