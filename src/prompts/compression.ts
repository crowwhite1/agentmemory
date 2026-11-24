export const COMPRESSION_SYSTEM = `You are a memory compression engine for an AI coding agent. Your job is to extract the essential information from a tool usage observation and compress it into structured data.

Output EXACTLY this XML format with no additional text:

<observation>
  <type>one of: file_read, file_write, file_edit, command_run, search, web_fetch, conversation, error, decision, discovery, subagent, notification, task, image, other</type>
  <title>Short descriptive title (max 80 chars)</title>
  <subtitle>One-line context (optional)</subtitle>
  <facts>
    <fact>Specific factual detail 1</fact>
    <fact>Specific factual detail 2</fact>
  </facts>
  <narrative>2-3 sentence summary of what happened and why it matters</narrative>
  <concepts>
    <concept>technical concept or pattern</concept>
  </concepts>
  <files>
    <file>path/to/file</file>
  </files>
  <importance>1-10 scale, 10 being critical architectural decision</importance>
</observation>

Rules:
- Escape &, <, and > inside text as &amp;, &lt;, and &gt;. Use only the tags shown, with no attributes or nested tags inside text fields.
- Each concept MUST be wrapped in its own <concept> element; never emit bare comma-separated text in <concepts>.
- For messages use conversation; for viewing images use image; for copying files use file_write. Choose only one listed type. Use other when no listed type fits.
- Be concise but preserve ALL technically relevant details
- File paths must be exact
- Importance: 1-3 for routine reads, 4-6 for edits/commands, 7-9 for architectural decisions, 10 for breaking changes
- Concepts should be reusable search terms (e.g., "React hooks", "SQL migration", "auth middleware"); keep them in the user's language: when the source content is not English, include at least one concept in that original language, and when the observation mixes languages include both the original-language and English terms so search works in either
- Strip any secrets, tokens, or credentials from the output
- Never copy Base64, data URIs, image bytes, or binary blobs into XML. Summarize what the image shows from available textual evidence.
- In <files>, output only actual filesystem paths from the observation, never image bytes, Base64, data URIs, or opaque payloads`;

export const COMPRESSION_JSON_SYSTEM = `Extract the essential factual information from an AI coding agent observation.
Return only a JSON object with type, title, subtitle, facts, narrative, concepts, files, importance.
Use arrays of strings for facts, concepts and files, at least one factual detail, and a narrative of at least 10 characters.
Choose a type from the supplied schema. For messages use conversation, for viewing images use image, and for copying files use file_write. Use other when no listed type fits.
Title: 1–80 characters. Subtitle: empty string if not applicable. Importance: integer from 1 to 10.
Preserve technical details, exact paths, and reusable search concepts in the source language (include both languages for mixed-language input).
Do not invent facts. Omit secrets, credentials, Base64, binary payloads and data URIs. Files must be actual paths from the source; use [] if none.`;

export function buildCompressionPrompt(observation: {
  hookType: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  assistantResponse?: string;
  timestamp: string;
}): string {
  const parts = [
    `Timestamp: ${observation.timestamp}`,
    `Hook: ${observation.hookType}`,
  ];

  if (observation.toolName) parts.push(`Tool: ${observation.toolName}`);
  if (observation.toolInput) {
    parts.push(`Input:\n${safePromptText(observation.toolInput, 4000)}`);
  }
  if (observation.toolOutput) {
    parts.push(`Output:\n${safePromptText(observation.toolOutput, 4000)}`);
  }
  if (observation.userPrompt) {
    parts.push(`User prompt:\n${safePromptText(observation.userPrompt, 2000)}`);
  }
  if (observation.assistantResponse) {
    parts.push(`Assistant response:\n${safePromptText(observation.assistantResponse, 4000)}`);
  }

  return parts.join("\n\n");
}

const IMAGE_DATA_URI = /data:(image\/[a-z0-9.+-]+);base64,[a-z0-9+\/=\s]{80,}/gi;
const BASE64_SEQUENCE = /[a-z0-9+\/]{256,}={0,2}/gi;
const BINARY_SIGNATURE = /^(?:\/9j\/|iVBORw0KGgo|R0lGOD|UklGR|JVBERi0|UEsDB)/;

export function sanitizeCompressionText(input: string): string {
  return input
    .replace(IMAGE_DATA_URI, (_match, mime: string) => `[omitted ${mime} binary image]`)
    .replace(BASE64_SEQUENCE, (value) => {
      if (BINARY_SIGNATURE.test(value) ||
          (/[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) &&
           /[+/]/.test(value))) {
        return "[omitted encoded binary payload]";
      }
      return value;
    });
}

function safePromptText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncate(sanitizeCompressionText(text ?? ""), limit);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n[...truncated]" : s;
}
