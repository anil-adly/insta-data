import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  instagram: {
    username: process.env.INSTAGRAM_USERNAME,
    password: process.env.INSTAGRAM_PASSWORD,
    baseUrl: "https://www.instagram.com",
  },
  downloads: {
    dir: path.resolve(
      process.env.DOWNLOAD_DIR || path.join(__dirname, "..", "downloads"),
    ),
    maxResults: parseInt(process.env.MAX_RESULTS || "10", 10),
  },
  search: {
    // Scroll rounds while harvesting paginated search results.
    maxScrollRounds: parseInt(
      process.env.SEARCH_MAX_SCROLL_ROUNDS || "150",
      10,
    ),
    // Stop when no new links appear for this many consecutive rounds.
    noNewRoundsToStop: parseInt(process.env.SEARCH_NO_NEW_ROUNDS || "8", 10),
    // Hard cap to avoid effectively infinite scraping loops.
    maxCollected: parseInt(process.env.SEARCH_MAX_COLLECTED || "2000", 10),
    // Used only in fallback verification mode when grid video detection is weak.
    verifyLimit: parseInt(process.env.SEARCH_VERIFY_LIMIT || "300", 10),
  },
  auth: {
    // Playwright saves session state here so you don't need to log in every time
    statePath: path.resolve(__dirname, "..", "auth", "session.json"),
  },
};
