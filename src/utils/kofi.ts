const KOFI_PROFILE = /^(?:https:\/\/)?(?:www\.)?ko-fi\.com\/([a-z0-9_-]+)\/?$/i;

export function normalizeKofiUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const handle = KOFI_PROFILE.exec(value.trim())?.[1];
  return handle ? `https://ko-fi.com/${handle}` : undefined;
}
