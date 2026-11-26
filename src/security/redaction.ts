const SECRET_KEY = /(?:password|passwd|secret|token|api[._-]?key|private[._-]?key|credential|sasl[._-]?jaas|authorization|bearer)/i;
const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/@:\s]+):([^/@\s]+)@/gi;
const JAAS_VALUE = /((?:password|username)\s*=\s*)"[^"]*"/gi;
const ENV_SECRET = /\$\{[^}]*?(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL)[^}]*\}/gi;

export const REDACTED = "[REDACTED]";

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function redactString(value: string): string {
  return value
    .replace(URI_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`)
    .replace(JAAS_VALUE, `$1"${REDACTED}"`)
    .replace(ENV_SECRET, REDACTED);
}

export function redactValue(value: unknown, key = ""): unknown {
  if (isSecretKey(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey)
      ])
    );
  }
  return value;
}

export function redactedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}
