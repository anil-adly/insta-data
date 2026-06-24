import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

/**
 * Launches a Chromium browser. If a saved session exists, it is reused so
 * you only have to log in once.
 */
async function launchBrowser({ freshLogin = false } = {}) {
  const stateDir = path.dirname(config.auth.statePath);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  const storageState = fs.existsSync(config.auth.statePath)
    ? config.auth.statePath
    : undefined;

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    storageState: freshLogin ? undefined : storageState,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Logs into Instagram if not already authenticated.
 * Saves the session so subsequent runs skip the login step.
 */
export async function login(options = {}) {
  const { browser, context, page } = await launchBrowser(options);

  const getPathname = () => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return "";
    }
  };

  const isTrustPath = (pathname) =>
    ["/challenge", "/two_factor", "/checkpoint"].some((p) =>
      pathname.includes(p),
    );

  const isOneTapPath = (pathname) => pathname.includes("/accounts/onetap");

  const detectPageState = async () => {
    const pathname = getPathname();

    const loginFormPresent =
      (await page
        .locator('form#login_form, input[name="email"], input[name="pass"]')
        .count()) > 0;

    const trustPath = isTrustPath(pathname);
    const oneTapPath = isOneTapPath(pathname);
    const loginPath = pathname.startsWith("/accounts/login");
    const trustCodeFieldPresent =
      (await page
        .locator(
          'label:has-text("Code"), input[autocomplete="one-time-code"], input[name*="code" i]',
        )
        .count()) > 0;

    const homeIndicators =
      (await page
        .locator('[aria-label="Search"], a[href="/explore/"]')
        .count()) > 0;

    if (trustPath || trustCodeFieldPresent) return "trust";
    if (oneTapPath) return "onetap";
    if (loginPath) return "login";
    if (loginFormPresent) return "login";
    if (homeIndicators) return "home";
    return "unknown";
  };

  const continueFromOneTap = async () => {
    // Sometimes Instagram lands on /accounts/onetap after trust.
    // Move to home feed where search/explore becomes available.
    await page.goto(`${config.instagram.baseUrl}/`, {
      waitUntil: "networkidle",
    });
  };

  const waitForTrustPageCompletion = async () => {
    console.log(
      "\nSecurity verification required.\n" +
        "Complete the trust/2FA code in the browser window.\n" +
        "Waiting up to 3 minutes...\n",
    );

    const deadline = Date.now() + 180_000;
    let state = await detectPageState();
    while (state === "trust" && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      state = await detectPageState();
    }

    if (state === "trust") {
      throw new Error(
        `Timed out waiting for trust/2FA completion at ${page.url()}`,
      );
    }

    console.log(`Trust/2FA step completed (state: ${state}).`);
  };

  const handleContinueScreenIfPresent = async () => {
    const continueButton = page.locator(
      'button:has-text("Continue"), div[role="button"]:has-text("Continue"), a:has-text("Continue")',
    );

    if ((await continueButton.count()) === 0) return false;

    console.log("Continue screen detected. Clicking Continue...");
    await continueButton.first().click();

    // Let Instagram settle on the next state page (login/trust/home)
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1200);
    return true;
  };

  try {
    await page.goto(`${config.instagram.baseUrl}/`, {
      waitUntil: "networkidle",
    });

    // Some sessions land on an interstitial with only a Continue button.
    // Click it first, then proceed with state detection.
    await handleContinueScreenIfPresent();

    // Step 1-3 state check on startup: login, trust, home
    let pageState = await detectPageState();
    console.log(`Startup page state: ${pageState}`);

    if (pageState === "home") {
      console.log("✓ Already logged in (session reused).");
      return { browser, context, page };
    }

    if (pageState === "trust") {
      await waitForTrustPageCompletion();
      await handleContinueScreenIfPresent();
      pageState = await detectPageState();
      console.log(`Post-trust page state: ${pageState}`);
      if (pageState === "onetap") {
        await continueFromOneTap();
        await handleContinueScreenIfPresent();
        pageState = await detectPageState();
        console.log(`After one-tap redirect, page state: ${pageState}`);
      }
      if (pageState === "home") {
        await context.storageState({ path: config.auth.statePath });
        console.log("✓ Session saved after trust verification.");
        return { browser, context, page };
      }
    }

    if (!config.instagram.username || !config.instagram.password) {
      throw new Error(
        "INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set in your .env file.",
      );
    }

    if (pageState !== "login") {
      await page.goto(`${config.instagram.baseUrl}/accounts/login/`, {
        waitUntil: "networkidle",
      });
      await handleContinueScreenIfPresent();
      pageState = await detectPageState();
      console.log(`After forcing login URL, page state: ${pageState}`);
    }

    if (pageState !== "login" && pageState !== "unknown") {
      throw new Error(
        `Expected login page but detected '${pageState}' at ${page.url()}`,
      );
    }

    console.log("Logging in to Instagram...");

    // Dismiss the cookie banner if present
    const acceptBtn = page.locator(
      'button:has-text("Allow all cookies"), button:has-text("Accept All")',
    );
    if (await acceptBtn.count()) await acceptBtn.first().click();

    // Instagram login fields can vary by rollout; use resilient selectors.
    const usernameInput = page.locator(
      'input[name="email"], input[name="username"], input[autocomplete*="username" i], input[aria-label*="username" i], input[aria-label*="email" i]',
    );
    const passwordInput = page.locator(
      'input[name="pass"], input[name="password"], input[type="password"]',
    );

    // Some account flows show a password-only modal after tapping Continue.
    // Support both full login form (username+password) and password-only modal.
    await passwordInput.first().waitFor({ state: "attached", timeout: 20_000 });
    const hasUsernameField = (await usernameInput.count()) > 0;

    if (hasUsernameField) {
      await usernameInput.first().click();
      await usernameInput.first().fill(config.instagram.username);
    }

    await passwordInput.first().click();
    await passwordInput.first().fill(config.instagram.password);

    const passwordModalForm = page.locator("form#aymh_password_entry_view");
    const onPasswordModal = (await passwordModalForm.count()) > 0;

    // Click login after entering password (required flow).
    const loginButton = onPasswordModal
      ? passwordModalForm.locator(
          'div[role="button"]:has-text("Log in"), button:has-text("Log in"), input[type="submit"]',
        )
      : page.locator(
          '[aria-label="Log in"], div[role="button"]:has-text("Log in"), button[type="submit"], button:has-text("Continue"), div[role="button"]:has-text("Continue")',
        );

    if (await loginButton.count()) {
      // Try normal click first, then force click, then DOM click fallback.
      await loginButton
        .first()
        .click({ timeout: 2000 })
        .catch(async () => {
          await loginButton
            .first()
            .click({ timeout: 2000, force: true })
            .catch(async () => {
              await loginButton
                .first()
                .dispatchEvent("click")
                .catch(() => {});
            });
        });
    }

    if (onPasswordModal) {
      // Explicit form submit avoids pointer-interception overlays in this modal.
      await page.evaluate(() => {
        const form = document.querySelector("form#aymh_password_entry_view");
        if (!form) return;

        const submitInput = form.querySelector('input[type="submit"]');
        if (submitInput instanceof HTMLElement) {
          submitInput.click();
          return;
        }

        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
          return;
        }

        form.submit();
      });
    }

    // Keep Enter as final fallback for cases where button click is swallowed.
    await passwordInput.first().press("Enter");

    // Step-by-step post-login checks: trust page first, then home.
    // Instagram can take time to transition after submit, especially when
    // it routes through OneTap or a challenge interstitial.
    await page.waitForLoadState("domcontentloaded");

    const submitDeadline = Date.now() + 60_000;
    let seenStableState = false;
    do {
      pageState = await detectPageState();
      if (pageState === "login" || pageState === "unknown") {
        await page.waitForTimeout(1000);
        continue;
      }

      seenStableState = true;
      break;
    } while (Date.now() < submitDeadline);

    if (!seenStableState && pageState === "unknown") {
      const pathname = getPathname();
      if (pathname.includes("/accounts/onetap")) {
        pageState = "onetap";
      }
    }

    console.log(`Post-login page state: ${pageState}`);

    if (pageState === "trust") {
      await waitForTrustPageCompletion();
      await handleContinueScreenIfPresent();
      pageState = await detectPageState();
      console.log(`After trust completion, page state: ${pageState}`);
    }

    if (pageState === "onetap") {
      await continueFromOneTap();
      await handleContinueScreenIfPresent();
      pageState = await detectPageState();
      console.log(`After one-tap redirect, page state: ${pageState}`);
    }

    if (pageState !== "home") {
      const invalidCreds =
        (await page
          .locator(
            'div:has-text("incorrect"), div:has-text("Wrong password"), div:has-text("Try again")',
          )
          .count()) > 0;
      if (invalidCreds) {
        throw new Error(
          "Instagram rejected the credentials. Please verify .env username/password.",
        );
      }
      throw new Error(
        `Login did not reach home page. Current state: ${pageState} (${page.url()})`,
      );
    }

    // Dismiss "Save your login info?" prompt if it appears
    const notNowBtn = page.locator(
      'button:has-text("Not Now"), button:has-text("Not now")',
    );
    if (await notNowBtn.count()) await notNowBtn.first().click();

    // Dismiss notifications prompt
    const notifBtn = page.locator('button:has-text("Not Now")');
    if (await notifBtn.count()) await notifBtn.first().click();

    // Persist session for next run
    await context.storageState({ path: config.auth.statePath });
    console.log("✓ Logged in and session saved.");

    return { browser, context, page };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Searches Instagram for `topic` and returns an array of post objects:
 *   { postUrl, thumbnailUrl, isVideo }
 *
 * Only reel / video posts are included.
 */
export async function searchVideos(page, topic) {
  console.log(`Searching Instagram for: "${topic}"…`);

  const normalizePostUrl = (url) => {
    if (!url) return "";
    return url.split("?")[0].split("#")[0].replace(/\/$/, "") + "/";
  };

  // Navigate straight to Instagram's keyword search results page instead of
  // driving the sidebar search box. The `q` param is URL-encoded, so a hashtag
  // topic like "#frequency" becomes ".../keyword/?q=%23frequency".
  const searchUrl = `${config.instagram.baseUrl}/explore/search/keyword/?q=${encodeURIComponent(
    topic,
  )}`;
  console.log(`Opening search results: ${searchUrl}`);

  // Instagram feed/explore pages keep background network activity alive and
  // rarely reach "networkidle", so wait for DOM + the post grid instead.
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // Give the results grid a chance to render before we start collecting.
  await page
    .locator('main a[href*="/p/"], main a[href*="/reel/"], main a[href*="/tv/"]')
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => {});

  const collectVisiblePostLinks = async () =>
    page.$$eval(
      'main a[href*="/p/"], main a[href*="/reel/"], main a[href*="/tv/"], a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]',
      (anchors) => {
        const normalized = [];
        const seen = new Set();

        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          const url = href.startsWith("http")
            ? href
            : `${location.origin}${href}`;

          if (
            !url.includes("/p/") &&
            !url.includes("/reel/") &&
            !url.includes("/tv/")
          ) {
            continue;
          }
          if (seen.has(url)) continue;

          const card = a.closest("article, li, div, a") || a;
          const isVideo =
            url.includes("/reel/") ||
            !!card.querySelector(
              'video, svg[aria-label*="Reel" i], svg[aria-label*="Video" i], [aria-label*="Reel" i], [aria-label*="Video" i]',
            );

          seen.add(url);
          normalized.push({ postUrl: url, isVideo });
        }

        return normalized;
      },
    );

  // Scroll down repeatedly and keep collecting until results stop growing.
  const collectedByUrl = new Map();
  let stagnantRounds = 0;
  let previousCount = 0;

  for (let round = 0; round < config.search.maxScrollRounds; round += 1) {
    const batch = await collectVisiblePostLinks();
    for (const item of batch) {
      const key = normalizePostUrl(item.postUrl);
      if (!key) continue;

      const existing = collectedByUrl.get(key);
      if (!existing) {
        collectedByUrl.set(key, { postUrl: key, isVideo: !!item.isVideo });
      } else if (!existing.isVideo && item.isVideo) {
        existing.isVideo = true;
      }
    }

    if (collectedByUrl.size >= config.search.maxCollected) {
      console.log(
        `Reached collection safety cap (${config.search.maxCollected}).`,
      );
      break;
    }

    if (collectedByUrl.size === previousCount) {
      stagnantRounds += 1;
    } else {
      previousCount = collectedByUrl.size;
      stagnantRounds = 0;
      if (collectedByUrl.size % 50 === 0) {
        console.log(`Collected ${collectedByUrl.size} unique post links...`);
      }
    }

    if (stagnantRounds >= config.search.noNewRoundsToStop) {
      break;
    }

    await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 1.6, 900));
    });
    await page.waitForTimeout(900);

    if ((round + 1) % 8 === 0) {
      await page.keyboard.press("End").catch(() => {});
      await page.waitForTimeout(700);
    }
  }

  const postLinks = Array.from(collectedByUrl.values());

  // Extra fallback: if nothing found in main, collect globally.
  const fallbackLinks = postLinks.length
    ? []
    : await page.$$eval(
        'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]',
        (anchors) =>
          anchors.map((a) => ({
            postUrl: a.href,
            isVideo:
              a.href.includes("/reel/") ||
              !!a.querySelector(
                'video, svg[aria-label="Reel"], svg[aria-label="Video"]',
              ),
          })),
      );

  // Merge and deduplicate
  const seen = new Set();
  const results = [];
  for (const item of [...postLinks, ...fallbackLinks]) {
    if (!seen.has(item.postUrl)) {
      seen.add(item.postUrl);
      results.push(item);
    }
  }

  let videos = results.filter((r) => r.isVideo || r.postUrl.includes("/reel/"));

  // If grid-level detection is too weak, verify candidates by opening posts.
  if (videos.length === 0 && results.length > 0) {
    console.log("No direct video cards detected. Verifying candidate posts...");
    const verified = [];

    for (const candidate of results.slice(0, config.search.verifyLimit)) {
      try {
        await page.goto(candidate.postUrl, {
          waitUntil: "domcontentloaded",
          timeout: 25_000,
        });

        const hasVideoTag = (await page.locator("video").count()) > 0;
        const hasOgVideo =
          (await page
            .locator('meta[property="og:video"], meta[property="og:video:url"]')
            .count()) > 0;

        if (hasVideoTag || hasOgVideo || candidate.postUrl.includes("/reel/")) {
          verified.push({ postUrl: candidate.postUrl, isVideo: true });
        }
      } catch {
        // Ignore individual candidate failures and continue checking others.
      }
    }

    videos = verified;
  }

  console.log(`Found ${videos.length} video post(s).`);
  return videos;
}
