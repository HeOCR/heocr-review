/** A credit display name chosen by the volunteer: short, printable, and not an email address or a link. */
export const MAX_DISPLAY_NAME = 60;

export function displayNameProblem(value: unknown): string | null {
  if (typeof value !== "string") return "display name must be text";
  const name = value.normalize("NFC").trim();
  if (!name) return "display name is empty";
  if (name.length > MAX_DISPLAY_NAME) return `display name must be at most ${MAX_DISPLAY_NAME} characters`;
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)) return "display name must not contain control or direction characters";
  if (!/\p{L}/u.test(name)) return "display name must contain a letter";
  if (/@|:\/\/|www\./i.test(name)) return "display name must not be an email address or a link";
  return null;
}

export function cleanDisplayName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}
