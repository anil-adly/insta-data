import fs from "fs";
import { config } from "./config.js";

// Instagram's web app id — the value the site itself sends on its private
// `i.instagram.com/api/v1` calls. Required for the media-info endpoint.
const IG_APP_ID = "936619743392459";
const IG_USER_AGENT = "Instagram 219.0.0.12.117 Android";

// Instagram shortcodes are a URL-safe base64 encoding of the numeric media pk.
const IG_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Extracts the shortcode from a post / reel / tv URL.
 * @param {string} postUrl
 * @returns {string|null}
 */
function extractShortcode(postUrl) {
  const match = String(postUrl || "").match(/\/(p|reel|tv)\/([^/?#]+)/i);
  return match?.[2] || null;
}

/**
 * Decodes an Instagram shortcode into its numeric media pk.
 *
 * The pk can exceed Number.MAX_SAFE_INTEGER, so this uses BigInt and returns
 * the id as a decimal string.
 *
 * @param {string} shortcode
 * @returns {string|null} Decimal media id, or null if the shortcode is invalid.
 */
export function shortcodeToMediaId(shortcode) {
  if (!shortcode) return null;
  let id = 0n;
  for (const ch of shortcode) {
    const idx = IG_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

/**
 * Builds a Cookie header (and csrf token) from the saved Playwright session.
 * @returns {{ header: string, csrf: string }}
 */
function buildCookieHeader() {
  const state = JSON.parse(fs.readFileSync(config.auth.statePath, "utf8"));
  const cookies = (Array.isArray(state.cookies) ? state.cookies : []).filter(
    (c) => c?.name && c?.value && (c.domain || "").includes("instagram.com"),
  );
  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const csrf = cookies.find((c) => c.name === "csrftoken")?.value || "";
  return { header, csrf };
}

/**
 * Fetches the view (play) count for an Instagram video post.
 *
 * yt-dlp does not populate `view_count` for Instagram clips, but Instagram's
 * own media-info endpoint still exposes it as `play_count`. We resolve the
 * numeric media id from the post's shortcode and query that endpoint with the
 * logged-in session cookies.
 *
 * Returns null (never throws) when the count is unavailable — e.g. cookies are
 * missing, the post is an image, the request times out, or Instagram rate-limits.
 *
 * @param {string} postUrl
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<number|null>}
 */
export async function fetchInstagramViewCount(postUrl, { timeoutMs = 15000 } = {}) {
  const mediaId = shortcodeToMediaId(extractShortcode(postUrl));
  if (!mediaId) return null;

  let cookieHeader;
  let csrf;
  try {
    ({ header: cookieHeader, csrf } = buildCookieHeader());
  } catch {
    return null;
  }
  if (!cookieHeader) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
      {
        headers: {
          "x-ig-app-id": IG_APP_ID,
          "x-csrftoken": csrf,
          "User-Agent": IG_USER_AGENT,
          Accept: "*/*",
          Cookie: cookieHeader,
        },
        signal: controller.signal,
      },
    );

    if (!res.ok) return null;

    const data = await res.json();
    const item = data?.items?.[0];
    if (!item) return null;

    // Reels expose `play_count`; some media use `ig_play_count`.
    const views = item.play_count ?? item.ig_play_count ?? item.view_count;
    return Number.isFinite(views) ? views : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
