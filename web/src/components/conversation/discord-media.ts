import { sanitizeLinkUri } from "../Markdown";

export function hexColor(n: number | null | undefined): string | undefined {
  if (typeof n !== "number" || n < 0 || n > 0xffffff) return undefined;
  return `#${n.toString(16).padStart(6, "0")}`;
}

// Discord's proxy_url routes through its CDN (stable, CORS-safe). Prefer it when present.
export function pickImageSrc(
  m: { url?: string; proxy_url?: string } | undefined
): string | undefined {
  if (!m) return undefined;
  const href = m.proxy_url || m.url;
  if (!href) return undefined;
  const safe = sanitizeLinkUri(href);
  return safe || undefined;
}

export interface SafeLink {
  href: string;
  target: string;
  rel: string;
}

export function externalLinkProps(url: string | null | undefined): SafeLink | null {
  if (!url) return null;
  const safe = sanitizeLinkUri(url);
  if (!safe) return null;
  return { href: safe, target: "_blank", rel: "noopener noreferrer" };
}
