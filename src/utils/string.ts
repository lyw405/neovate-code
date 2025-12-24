/**
 * Converts a kebab-case string to Title Case.
 * Examples:
 * - "foo-bar" → "Foo Bar"
 * - "review" → "Review"
 * - "multi-word-command" → "Multi Word Command"
 */
export function kebabToTitleCase(kebabString: string): string {
  if (!kebabString) return '';

  return kebabString
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
