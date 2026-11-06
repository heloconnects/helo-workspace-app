import { createHash, randomBytes } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Opaque identifier: a prefix and 8 random bytes in hex. */
export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

/** JSON with object keys sorted, so the same value always serialises to the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function prettyCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
