const CANONICAL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_REGEX.test(value.trim());
}

export function assertValidUuid(value: unknown, label: string): string {
  if (!isValidUuid(value)) {
    throw new Error(`Invalid or missing ${label}: expected canonical UUID.`);
  }
  return value.trim().toLowerCase();
}

