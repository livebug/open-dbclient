/**
 * Merging a bundled data file with a user copy of it.
 *
 * Several things in this extension are data rather than code - connection templates, custom actions -
 * and the point of them being data is that a user can add to them. The bundled file has to keep
 * working on its own, so the user file is optional and additive; it never replaces the bundled one
 * wholesale, because then a new release could not add an entry without every user re-copying the file.
 */

export interface Identified {
  readonly id: string;
}

/** A user entry may set this to remove a bundled entry rather than replacing it. */
export interface Disableable {
  readonly disabled?: boolean;
}

/**
 * Overlays user entries onto bundled ones, matching by `id`.
 *
 * - a user entry whose id matches a bundled one replaces it, in the bundled entry's position, so
 *   customising an entry does not shuffle the picker
 * - a user entry with `disabled: true` removes the bundled entry
 * - a user entry with a new id is appended, in the order it appears
 * - an entry without an id is kept as-is when it is bundled, and dropped when it comes from the user,
 *   because an entry that cannot be referred to cannot be overridden either
 */
export function mergeById<T extends Identified & Disableable>(
  bundled: readonly T[],
  user: readonly T[],
): T[] {
  const replacements = new Map<string, T>();
  const additions: T[] = [];

  const bundledIds = new Set(bundled.map((entry) => entry.id));
  for (const entry of user) {
    if (!entry.id) {
      continue;
    }
    if (bundledIds.has(entry.id)) {
      replacements.set(entry.id, entry);
    } else {
      additions.push(entry);
    }
  }

  const merged: T[] = [];
  for (const entry of bundled) {
    const replacement = replacements.get(entry.id);
    const effective = replacement ?? entry;
    if (effective.disabled === true) {
      continue;
    }
    // `disabled` is a directive for the merger, not part of the entry.
    const { disabled: _disabled, ...rest } = effective as T & { disabled?: boolean };
    merged.push(rest as T);
  }

  for (const entry of additions) {
    if (entry.disabled === true) {
      continue;
    }
    const { disabled: _disabled, ...rest } = entry as T & { disabled?: boolean };
    merged.push(rest as T);
  }

  return merged;
}

/**
 * Reads the `entries`-style array out of a parsed JSON document.
 *
 * Returns an empty array for anything unexpected. These files are a convenience, and a typo in one
 * must not stop the extension from working.
 */
export function readEntries(parsed: unknown, key: string): Identified[] {
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const value = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Identified =>
      typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string',
  );
}
