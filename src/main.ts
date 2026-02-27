/**
 * Tastly Google Maps Review Scraper
 *
 * Scrapes reviews from Google Maps restaurant pages using Playwright.
 * Google Maps loads reviews in a scrollable side panel — we scroll to
 * load more, expand truncated text, and extract all review data from DOM.
 *
 * Each restaurant URL is processed independently with its own crawler
 * instance to avoid shared request-counter bugs.
 */

import { Actor, log } from "apify";
import { PlaywrightCrawler, type ProxyConfiguration } from "crawlee";
import type { GoogleScraperInput, GoogleReview } from "./types.js";
import { parseRelativeDate } from "./utils.js";

await Actor.init();

const input = (await Actor.getInput<GoogleScraperInput>()) ?? ({} as GoogleScraperInput);
const { startUrls = [], maxItems = 100 } = input;

if (!startUrls.length) {
    throw new Error("No startUrls provided. Please supply at least one Google Maps URL.");
}

// ---------------------------------------------------------------------------
// Proxy configuration
// ---------------------------------------------------------------------------
let proxyConfiguration: ProxyConfiguration | undefined;
try {
    proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ["RESIDENTIAL"],
    });
    log.info("Using RESIDENTIAL proxy");
} catch {
    try {
        proxyConfiguration = await Actor.createProxyConfiguration();
        log.info("Using default proxy");
    } catch (err) {
        log.warning(`No proxy available: ${err}`);
    }
}

/**
 * Ensure the URL has hl=en to force English regardless of proxy location.
 */
function ensureEnglish(rawUrl: string): string {
    const u = new URL(rawUrl);
    u.searchParams.set("hl", "en");
    return u.toString();
}

// ---------------------------------------------------------------------------
// Process each restaurant URL independently
// ---------------------------------------------------------------------------
for (const { url: rawUrl } of startUrls) {
    const url = ensureEnglish(rawUrl);
    log.info(`\n=== Processing ${url} ===`);

    const collectedReviews: GoogleReview[] = [];
    const seenIds = new Set<string>();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 1,
        maxRequestRetries: 5,
        headless: true,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: { maxErrorScore: 1 },
        },
        launchContext: {
            launchOptions: {
                args: ["--no-sandbox", "--disable-setuid-sandbox"],
            },
        },
        requestHandlerTimeoutSecs: 300,
        navigationTimeoutSecs: 60,

        async requestHandler({ page, request }) {
            if (collectedReviews.length >= maxItems) return;

            log.info(`Navigating to ${request.url}`);
            await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForTimeout(4000);

            // -----------------------------------------------------------------
            // Dismiss cookie consent if present
            // -----------------------------------------------------------------
            const consentBtn = await page.$('button[aria-label="Accept all"], form[action*="consent"] button');
            if (consentBtn) {
                log.info("  Dismissing consent dialog...");
                await consentBtn.click().catch(() => {});
                await page.waitForTimeout(2000);
            }

            // -----------------------------------------------------------------
            // If this is a search URL, click first place result
            // -----------------------------------------------------------------
            if (request.url.includes("/maps/search/")) {
                await page.waitForTimeout(2000);
                const firstResult = await page.$('a[href*="/maps/place/"]');
                if (firstResult) {
                    log.info("  Clicking first search result...");
                    await firstResult.click();
                    await page.waitForTimeout(4000);
                }
            }

            // -----------------------------------------------------------------
            // Navigate to Reviews tab
            // Tab buttons have role="tab" — Reviews is typically the 2nd tab
            // -----------------------------------------------------------------
            let reviewsClicked = false;

            // Strategy 1: button with aria-label containing "Reviews"
            const reviewsTabByLabel = await page.$('button[role="tab"][aria-label*="Reviews"], button[role="tab"][aria-label*="reviews"]');
            if (reviewsTabByLabel) {
                log.info("  Clicking Reviews tab (aria-label match)...");
                await reviewsTabByLabel.click();
                reviewsClicked = true;
            }

            // Strategy 2: tab buttons — click the one with "Review" text
            if (!reviewsClicked) {
                const tabs = await page.$$('button[role="tab"]');
                for (const tab of tabs) {
                    const text = await tab.textContent();
                    if (text && /review/i.test(text)) {
                        log.info(`  Clicking tab: "${text.trim()}"...`);
                        await tab.click();
                        reviewsClicked = true;
                        break;
                    }
                }
            }

            // Strategy 3: data-tab-index="1" (Reviews is typically index 1)
            if (!reviewsClicked) {
                const tabByIndex = await page.$('button[data-tab-index="1"]');
                if (tabByIndex) {
                    log.info("  Clicking tab index 1...");
                    await tabByIndex.click();
                    reviewsClicked = true;
                }
            }

            if (!reviewsClicked) {
                log.warning("  Could not find Reviews tab");
            }

            // Wait for reviews to load
            await page.waitForTimeout(3000);

            // -----------------------------------------------------------------
            // Sort by "Newest"
            // -----------------------------------------------------------------
            const sortButton = await page.$('button[aria-label="Sort reviews"], button[aria-label*="sort" i], button[data-value="Sort"]');
            if (sortButton) {
                log.info("  Opening sort menu...");
                await sortButton.click();
                await page.waitForTimeout(1000);

                // Click "Newest" in the menu
                const menuItems = await page.$$('div[role="menuitemradio"], li[role="menuitemradio"]');
                for (const item of menuItems) {
                    const text = await item.textContent();
                    if (text && /newest/i.test(text)) {
                        log.info("  Sorting by Newest...");
                        await item.click();
                        await page.waitForTimeout(2000);
                        break;
                    }
                }
            }

            // -----------------------------------------------------------------
            // DOM diagnostic — identify review card selector
            // -----------------------------------------------------------------
            const reviewSelector = await page.evaluate(() => {
                // Try multiple known selectors for review cards
                const candidates = [
                    'div[data-review-id]',
                    'div.jftiEf',
                    'div.jJc9Ad',
                    'div.GHT2ce',
                ];
                for (const sel of candidates) {
                    const count = document.querySelectorAll(sel).length;
                    if (count > 0) return { selector: sel, count };
                }

                // Fallback: find elements with star rating aria-labels
                // and walk up to find the common card container
                const starEls = document.querySelectorAll('[role="img"][aria-label*="star" i]');
                if (starEls.length > 0) {
                    // Check parent classes to find a common container
                    const parent = starEls[0].closest('[data-review-id], div.jftiEf, div.jJc9Ad');
                    if (parent) {
                        const tag = parent.tagName.toLowerCase();
                        const cls = parent.className ? `.${String(parent.className).split(' ')[0]}` : '';
                        return { selector: `${tag}${cls}`, count: -1 };
                    }
                }

                return { selector: "none", count: 0 };
            });
            log.info(`  Review card selector: "${reviewSelector.selector}" (${reviewSelector.count} found)`);

            // -----------------------------------------------------------------
            // Extra diagnostics if no reviews found
            // -----------------------------------------------------------------
            if (reviewSelector.count === 0 && reviewSelector.selector === "none") {
                const debugInfo = await page.evaluate(() => {
                    const results: string[] = [];
                    const title = document.title;
                    results.push(`Page title: ${title}`);

                    // Check all role="img" elements
                    const imgRoles = document.querySelectorAll('[role="img"]');
                    results.push(`role="img" elements: ${imgRoles.length}`);
                    for (let i = 0; i < Math.min(imgRoles.length, 5); i++) {
                        const el = imgRoles[i];
                        results.push(`  [${i}] ${el.tagName} aria-label="${el.getAttribute("aria-label")?.slice(0, 50)}"`);
                    }

                    // Dump scrollable container content
                    const scrollable = document.querySelector('div.m6QErb.DxyBCb') || document.querySelector('div.m6QErb');
                    if (scrollable) {
                        results.push(`Scrollable container children: ${scrollable.children.length}`);
                        for (let i = 0; i < Math.min(scrollable.children.length, 5); i++) {
                            const child = scrollable.children[i];
                            const cls = child.className ? String(child.className).slice(0, 60) : "";
                            const text = (child.textContent || "").trim().slice(0, 80);
                            const dataAttrs = Array.from(child.attributes)
                                .filter(a => a.name.startsWith("data-"))
                                .map(a => `${a.name}="${a.value.slice(0, 20)}"`)
                                .join(" ");
                            results.push(`  [${i}] ${child.tagName} class="${cls}" ${dataAttrs}: "${text}"`);
                        }
                    } else {
                        results.push("No scrollable container found");
                    }

                    return results;
                });
                log.info("  === DIAGNOSTIC ===");
                for (const line of debugInfo) {
                    log.info(`    ${line}`);
                }
            }

            // -----------------------------------------------------------------
            // Scroll the reviews panel to load more reviews
            // -----------------------------------------------------------------
            const cardSelector = reviewSelector.selector !== "none" ? reviewSelector.selector : 'div[data-review-id]';

            const maxScrollAttempts = Math.ceil(maxItems / 10) + 5;
            let lastReviewCount = 0;
            let noNewReviewsCount = 0;

            for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts; scrollAttempt++) {
                const currentCount = await page.$$eval(
                    cardSelector,
                    (els: Element[]) => els.length,
                );

                if (currentCount >= maxItems) {
                    log.info(`  Loaded ${currentCount} reviews, stopping scroll`);
                    break;
                }

                if (currentCount === lastReviewCount) {
                    noNewReviewsCount++;
                    if (noNewReviewsCount >= 3) {
                        log.info(`  No new reviews after ${noNewReviewsCount} scrolls (${currentCount} total)`);
                        break;
                    }
                } else {
                    noNewReviewsCount = 0;
                    if (scrollAttempt % 3 === 0) {
                        log.info(`  Scrolling... ${currentCount} reviews loaded`);
                    }
                }
                lastReviewCount = currentCount;

                await page.evaluate(() => {
                    const scrollEl =
                        document.querySelector('div.m6QErb.DxyBCb') ||
                        document.querySelector('div.m6QErb.WNBkOb') ||
                        document.querySelector('div.m6QErb');
                    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
                });
                await page.waitForTimeout(2000);
            }

            // -----------------------------------------------------------------
            // Expand all truncated reviews ("More" / "See more" buttons)
            // -----------------------------------------------------------------
            const moreButtons = await page.$$('button.w8nwRe.kyuRq, button[aria-label="See more"], button[aria-expanded="false"]');
            if (moreButtons.length > 0) {
                log.info(`  Expanding ${moreButtons.length} truncated reviews...`);
                for (const btn of moreButtons) {
                    await btn.click().catch(() => {});
                }
                await page.waitForTimeout(500);
            }

            // -----------------------------------------------------------------
            // Extract reviews from the DOM
            // -----------------------------------------------------------------
            const pageReviews = await page.evaluate((sel: string) => {
                const reviews: Array<Record<string, unknown>> = [];
                const cards = document.querySelectorAll(sel);

                cards.forEach((card, idx) => {
                    try {
                        // === Review ID ===
                        let reviewId = card.getAttribute("data-review-id") || `g-${idx}-${Date.now()}`;

                        // === Star rating ===
                        let stars = 0;
                        const starEl = card.querySelector('[role="img"][aria-label*="star" i]');
                        if (starEl) {
                            const m = starEl.getAttribute("aria-label")?.match(/(\d+)/);
                            if (m) stars = parseInt(m[1]);
                        }

                        // === Reviewer name ===
                        let name = "Anonymous";
                        // Try multiple selectors for the name
                        const nameEl =
                            card.querySelector('div.d4r55') ||
                            card.querySelector('a[href*="/contrib/"] div') ||
                            card.querySelector('button[data-review-id] div');
                        if (nameEl) {
                            const n = nameEl.textContent?.trim() || "";
                            if (n.length > 0 && n.length < 80) name = n;
                        }
                        // Fallback: first link text inside the card
                        if (name === "Anonymous") {
                            const firstLink = card.querySelector("a");
                            if (firstLink) {
                                const n = firstLink.textContent?.trim() || "";
                                if (n.length > 1 && n.length < 60) name = n;
                            }
                        }

                        // === Date ===
                        let dateText = "";
                        const dateEl = card.querySelector('span.rsqaWe');
                        if (dateEl) {
                            dateText = dateEl.textContent?.trim() || "";
                        }
                        if (!dateText) {
                            const spans = card.querySelectorAll("span");
                            for (const s of spans) {
                                const t = s.textContent?.trim() || "";
                                if (/\d+\s+(day|week|month|year)s?\s+ago/i.test(t) || /^a[n]?\s+(day|week|month|year)\s+ago$/i.test(t)) {
                                    dateText = t;
                                    break;
                                }
                            }
                        }

                        // === Review text ===
                        let text: string | null = null;
                        const textEl = card.querySelector('span.wiI7pd') || card.querySelector('div.MyEned span');
                        if (textEl) {
                            const t = textEl.textContent?.trim() || "";
                            if (t.length > 0) text = t;
                        }
                        // Fallback: longest span with text > 30 chars
                        if (!text) {
                            const spans = card.querySelectorAll("span");
                            let maxLen = 0;
                            for (const s of spans) {
                                const t = s.textContent?.trim() || "";
                                if (t.length > maxLen && t.length > 30) {
                                    text = t;
                                    maxLen = t.length;
                                }
                            }
                        }

                        // === Owner response ===
                        let responseFromOwnerText: string | null = null;
                        let responseFromOwnerDate: string | null = null;
                        const responseContainer = card.querySelector('div.CDe7pd');
                        if (responseContainer) {
                            const respText = responseContainer.querySelector('div.wiI7pd, span.wiI7pd');
                            if (respText) responseFromOwnerText = respText.textContent?.trim() || null;
                            const respDate = responseContainer.querySelector('span.DZSIDd');
                            if (respDate) responseFromOwnerDate = respDate.textContent?.trim() || null;
                        }

                        // === Likes ===
                        let likesCount = 0;
                        const likesEl = card.querySelector('span.pkWtMe');
                        if (likesEl) {
                            const m = likesEl.textContent?.match(/(\d+)/);
                            if (m) likesCount = parseInt(m[1]);
                        }

                        // === Reviewer info ===
                        let reviewerNumberOfReviews: number | null = null;
                        let isLocalGuide = false;
                        const infoEls = card.querySelectorAll('div.RfnDt span, span');
                        for (const el of infoEls) {
                            const t = el.textContent?.trim() || "";
                            if (t.includes("Local Guide")) isLocalGuide = true;
                            const m = t.match(/(\d+)\s+review/i);
                            if (m) reviewerNumberOfReviews = parseInt(m[1]);
                        }

                        if (stars >= 1 && stars <= 5) {
                            reviews.push({
                                reviewId, name, stars, dateText, text,
                                responseFromOwnerText, responseFromOwnerDate,
                                likesCount, reviewerNumberOfReviews, isLocalGuide,
                            });
                        }
                    } catch {
                        // Skip malformed
                    }
                });

                return reviews;
            }, cardSelector);

            log.info(`  Extracted ${pageReviews.length} reviews from DOM`);

            for (const rev of pageReviews) {
                if (collectedReviews.length >= maxItems) break;
                const rid = String(rev.reviewId);
                if (seenIds.has(rid)) continue;
                seenIds.add(rid);

                collectedReviews.push({
                    reviewId: rid,
                    name: String(rev.name || "Anonymous"),
                    stars: Number(rev.stars),
                    publishedAtDate: parseRelativeDate(String(rev.dateText || "")),
                    text: rev.text ? String(rev.text) : null,
                    reviewUrl: null,
                    responseFromOwnerText: rev.responseFromOwnerText ? String(rev.responseFromOwnerText) : null,
                    responseFromOwnerDate: rev.responseFromOwnerDate ? String(rev.responseFromOwnerDate) : null,
                    likesCount: Number(rev.likesCount || 0),
                    reviewDetailedRating: null,
                    reviewerNumberOfReviews: rev.reviewerNumberOfReviews != null ? Number(rev.reviewerNumberOfReviews) : null,
                    isLocalGuide: Boolean(rev.isLocalGuide),
                    language: "en",
                    reviewOrigin: "Google",
                });
            }

            log.info(`  Total collected: ${collectedReviews.length}/${maxItems}`);
        },
    });

    await crawler.run([{ url }]);

    if (collectedReviews.length > 0) {
        log.info(`Collected ${collectedReviews.length} reviews`);
        await Actor.pushData(collectedReviews);
    } else {
        log.error(`No reviews collected for ${url}`);
    }
}

await Actor.exit();
