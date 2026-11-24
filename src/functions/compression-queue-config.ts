/** Shared queue configuration catalog for runtime and the settings UI. */
export const compressionQueueSettings = {
  AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS: {
    fallback: 2, min: 1, max: 20,
    description: "Число попыток компрессии на одну задачу (1–20). После исчерпания — ручной повтор.",
  },
  AGENTMEMORY_COMPRESSION_QUEUE_BACKFILL_MS: {
    fallback: 300_000, min: 30_000, max: 86_400_000,
    description: "Интервал поиска незапланированных ожидающих observations, мс (30 с – 24 ч). Старые ошибки автоматически не повторяются.",
  },
  AGENTMEMORY_COMPRESSION_QUEUE_RETRY_BASE_MS: {
    fallback: 15_000, min: 1_000, max: 300_000,
    description: "Начальная задержка автоматического повтора, мс (1 с – 5 мин). Удваивается после каждой неудачи до максимума.",
  },
  AGENTMEMORY_COMPRESSION_QUEUE_RETRY_MAX_MS: {
    fallback: 300_000, min: 1_000, max: 3_600_000,
    description: "Максимальная задержка между автоматическими повторами, мс (1 с – 1 ч).",
  },
} as const;

type QueueSetting = keyof typeof compressionQueueSettings;
export function validQueueSetting(key: string, value: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(compressionQueueSettings, key)) return true;
  if (value === "") return true; // clear override to restore default
  const rule = compressionQueueSettings[key as QueueSetting];
  const number = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(number) && number >= rule.min && number <= rule.max;
}

export function readCompressionQueueSettings(env = process.env) {
  function read(key: QueueSetting): number {
    const value = env[key];
    return value && validQueueSetting(key, value) ? Number(value) : compressionQueueSettings[key].fallback;
  }
  return {
    maxAttempts: read("AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS"),
    backfillMs: read("AGENTMEMORY_COMPRESSION_QUEUE_BACKFILL_MS"),
    retryBaseMs: read("AGENTMEMORY_COMPRESSION_QUEUE_RETRY_BASE_MS"),
    retryMaxMs: read("AGENTMEMORY_COMPRESSION_QUEUE_RETRY_MAX_MS"),
  };
}
