/**
 * OpenRouter app attribution.
 *
 * OpenRouter ranks apps and agents by the traffic that identifies itself with
 * two headers: `X-Title` and `HTTP-Referer`. There is no submission form — you
 * show up by sending attributed traffic. So every request this router makes
 * carries them by default, whether it runs under Pi, OpenCode, or the gateway.
 *
 * Override with `SWITCHYARD_APP_TITLE` and `SWITCHYARD_APP_URL` if you fork this
 * and want your own name on your own traffic.
 */

export const DEFAULT_APP_TITLE = "Switchyard";
export const DEFAULT_APP_URL = "https://github.com/LeonardSEO/switchyard";

export interface Attribution {
  title?: string;
  referer?: string;
}

export function attribution(overrides: Attribution = {}): Required<Attribution> {
  return {
    // Empty means unset: never send a blank attribution header.
    title: overrides.title || process.env.SWITCHYARD_APP_TITLE || DEFAULT_APP_TITLE,
    referer: overrides.referer || process.env.SWITCHYARD_APP_URL || DEFAULT_APP_URL,
  };
}

export function attributionHeaders(overrides: Attribution = {}): Record<string, string> {
  const { title, referer } = attribution(overrides);
  const headers: Record<string, string> = {};
  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-Title"] = title;
  return headers;
}
