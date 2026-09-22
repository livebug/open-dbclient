/**
 * Reading and writing the `key=value;key=value` text used for JDBC driver properties.
 *
 * Kept apart from the form so the same rules apply wherever the text is edited, and so they can be
 * tested without an editor.
 */

/** Renders properties back into the editable text form. */
export function formatProperties(
  properties: Readonly<Record<string, string>> | undefined,
): string {
  return properties
    ? Object.entries(properties)
        .map(([key, value]) => `${key}=${value}`)
        .join(';')
    : '';
}

/**
 * Parses the text form.
 *
 * Only the first `=` splits a pair, because connection properties routinely contain `=` in their
 * values - passwords especially.
 */
export function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of text.split(';')) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator > 0) {
      result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    }
  }
  return result;
}

/** Returns the first problem with the text, or undefined when it is well formed. */
export function validateProperties(value: string): string | undefined {
  for (const entry of value.split(';')) {
    const trimmed = entry.trim();
    if (trimmed !== '' && !trimmed.includes('=')) {
      return `'${trimmed}' is not key=value`;
    }
  }
  return undefined;
}

/** Returns the first problem with a JDBC URL, or undefined when it looks usable. */
export function validateJdbcUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'A JDBC URL is required';
  }
  return trimmed.toLowerCase().startsWith('jdbc:') ? undefined : "A JDBC URL starts with 'jdbc:'";
}
