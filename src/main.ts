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

// ---------------------------------------------------------------------------
// Process each restaurant URL independently
// ---------------------------------------------------------------------------
for (const { url } of startUrls) {
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
            await page.waitForTimeout(3000);

            // -----------------------------------------------------------------
            // If this is a search URL, it may resolve to a place page directly
            // or show search results. If search results, click first result.
            // -----------------------------------------------------------------
            const isSearchUrl = request.url.includes("/maps/search/");
            if (isSearchUrl) {
                // Wait for either a place panel or search results
                await page.waitForTimeout(2000);
                const firstResult = await page.$('a[href*="/maps/place/"]');
                if (firstResult) {
                    log.info("  Search results found, clicking first result...");
                    await firstResult.click();
                    await page.waitForTimeout(3000);
                }
            }

            // -----------------------------------------------------------------
            // Click the "Reviews" tab to open the reviews panel
            // -----------------------------------------------------------------
            const reviewsTab = await page.$('button[aria-label*="Reviews"], button[data-tab-index="1"]');
            if (reviewsTab) {
                log.info("  Clicking Reviews tab...");
                await reviewsTab.click();
                await page.waitForTimeout(2000);
            } else {
                // Try clicking the review count text (e.g., "1,234 reviews")
                const reviewLink = await page.$('button:has-text("review"), span:has-text("review")');
                if (reviewLink) {
                    await reviewLink.click();
                    await page.waitForTimeout(2000);
                }
            }

            // -----------------------------------------------------------------
            // Sort by "Newest" if the sort button is available
            // -----------------------------------------------------------------
            const sortButton = await page.$('button[aria-label="Sort reviews"], button[data-value="Sort"]');
            if (sortButton) {
                log.info("  Opening sort menu...");
                await sortButton.click();
                await page.waitForTimeout(1000);
                // Click "Newest" option in the dropdown
                const newestOption = await page.$('li[data-index="1"], div[role="menuitemradio"]:has-text("Newest")');
                if (newestOption) {
                    log.info("  Sorting by Newest...");
                    await newestOption.click();
                    await page.waitForTimeout(2000);
                }
            }

            // -----------------------------------------------------------------
            // Find the scrollable reviews container and scroll to load reviews
            // -----------------------------------------------------------------
            const scrollable = await page.$('div[role="main"] div.m6QErb.DxyBCb, div.m6QErb.WNBkOb');
            if (!scrollable) {
                log.warning("  Could not find scrollable reviews container.");
                // Try alternative: scroll the main panel
                const mainPanel = await page.$('div[role="main"]');
                if (!mainPanel) {
                    log.error("  No main panel found. Page may not have loaded correctly.");
                    const bodyText = await page.evaluate(() => document.body?.textContent?.slice(0, 500) || "");
                    log.warning(`  Body: ${bodyText}`);
                    return;
                }
            }

            // Scroll to load reviews — Google loads ~10 at a time
            const maxScrollAttempts = Math.ceil(maxItems / 10) + 5;
            let lastReviewCount = 0;
            let noNewReviewsCount = 0;

            for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts; scrollAttempt++) {
                // Count current reviews
                const currentCount = await page.$$eval(
                    'div[data-review-id], div[jsaction*="review"]',
                    (els: Element[]) => els.length,
                );

                if (currentCount >= maxItems) {
                    log.info(`  Loaded ${currentCount} reviews (>= maxItems), stopping scroll`);
                    break;
                }

                if (currentCount === lastReviewCount) {
                    noNewReviewsCount++;
                    if (noNewReviewsCount >= 3) {
                        log.info(`  No new reviews after ${noNewReviewsCount} scrolls (${currentCount} total), stopping`);
                        break;
                    }
                } else {
                    noNewReviewsCount = 0;
                    if (scrollAttempt % 5 === 0) {
                        log.info(`  Loaded ${currentCount} reviews so far...`);
                    }
                }
                lastReviewCount = currentCount;

                // Scroll the reviews panel
                await page.evaluate(() => {
                    const scrollEl =
                        document.querySelector('div[role="main"] div.m6QErb.DxyBCb') ||
                        document.querySelector('div[role="main"] div.m6QErb.WNBkOb') ||
                        document.querySelector('div[role="main"] div.m6QErb');
                    if (scrollEl) {
                        scrollEl.scrollTop = scrollEl.scrollHeight;
                    }
                });
                await page.waitForTimeout(1500);
            }

            // -----------------------------------------------------------------
            // Expand all truncated review texts ("More" buttons)
            // -----------------------------------------------------------------
            const moreButtons = await page.$$('button.w8nwRe.kyuRq, button[aria-label="See more"], button:has-text("More")');
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
            const pageReviews = await page.evaluate(() => {
                const reviews: Array<Record<string, unknown>> = [];
                // Google Maps review cards have data-review-id attribute
                const cards = document.querySelectorAll('div[data-review-id]');

                cards.forEach((card) => {
                    try {
                        const reviewId = card.getAttribute("data-review-id") || "";
                        if (!reviewId) return;

                        // === Star rating ===
                        // aria-label like "5 stars" or "4 stars" on the star container
                        let stars = 0;
                        const starEl = card.querySelector('span[role="img"][aria-label*="star"]');
                        if (starEl) {
                            const m = starEl.getAttribute("aria-label")?.match(/(\d+)/);
                            if (m) stars = parseInt(m[1]);
                        }
                        if (!stars) {
                            // Count filled star SVGs
                            const filledStars = card.querySelectorAll('img[src*="star_yellow"], span.hCCjke.google-symbols');
                            if (filledStars.length >= 1 && filledStars.length <= 5) {
                                stars = filledStars.length;
                            }
                        }

                        // === Reviewer name ===
                        let name = "Anonymous";
                        const nameEl =
                            card.querySelector('div.d4r55, button.WEBjve div.d4r55') ||
                            card.querySelector('a[href*="/contrib/"] div, button[data-review-id] div.d4r55');
                        if (nameEl) {
                            const n = nameEl.textContent?.trim() || "";
                            if (n.length > 0 && n.length < 80) name = n;
                        }

                        // === Date ===
                        let dateText = "";
                        const dateEl = card.querySelector('span.rsqaWe');
                        if (dateEl) {
                            dateText = dateEl.textContent?.trim() || "";
                        }
                        if (!dateText) {
                            // Fallback: look for text like "X months ago"
                            const spans = card.querySelectorAll("span");
                            for (const s of spans) {
                                const t = s.textContent?.trim() || "";
                                if (t.match(/\d+\s+(day|week|month|year)s?\s+ago/i) || t.match(/^a[n]?\s+(day|week|month|year)\s+ago$/i)) {
                                    dateText = t;
                                    break;
                                }
                            }
                        }

                        // === Review text ===
                        let text: string | null = null;
                        const textEl =
                            card.querySelector('span.wiI7pd') ||
                            card.querySelector('div.MyEned span');
                        if (textEl) {
                            const t = textEl.textContent?.trim() || "";
                            if (t.length > 0) text = t;
                        }

                        // === Owner response ===
                        let responseFromOwnerText: string | null = null;
                        let responseFromOwnerDate: string | null = null;
                        const responseContainer = card.querySelector('div.CDe7pd');
                        if (responseContainer) {
                            const responseTextEl = responseContainer.querySelector('div.wiI7pd');
                            if (responseTextEl) {
                                responseFromOwnerText = responseTextEl.textContent?.trim() || null;
                            }
                            const responseDateEl = responseContainer.querySelector('span.DZSIDd');
                            if (responseDateEl) {
                                responseFromOwnerDate = responseDateEl.textContent?.trim() || null;
                            }
                        }

                        // === Likes count ===
                        let likesCount = 0;
                        const likesEl = card.querySelector('span.pkWtMe');
                        if (likesEl) {
                            const m = likesEl.textContent?.match(/(\d+)/);
                            if (m) likesCount = parseInt(m[1]);
                        }

                        // === Detailed ratings (Food, Service, Atmosphere) ===
                        let reviewDetailedRating: Record<string, number> | null = null;
                        const ratingRows = card.querySelectorAll('div.k1MNkf, div[class*="PBBkOb"]');
                        if (ratingRows.length > 0) {
                            reviewDetailedRating = {};
                            for (const row of ratingRows) {
                                const label = row.querySelector("span")?.textContent?.trim() || "";
                                const ratingEl = row.querySelector('span[role="img"]');
                                if (ratingEl) {
                                    const m = ratingEl.getAttribute("aria-label")?.match(/(\d+)/);
                                    if (m && label) {
                                        reviewDetailedRating[label] = parseInt(m[1]);
                                    }
                                }
                            }
                            if (Object.keys(reviewDetailedRating).length === 0) {
                                reviewDetailedRating = null;
                            }
                        }

                        // === Reviewer info ===
                        let reviewerNumberOfReviews: number | null = null;
                        let isLocalGuide = false;
                        const reviewerInfoEls = card.querySelectorAll('div.RfnDt span');
                        for (const el of reviewerInfoEls) {
                            const t = el.textContent?.trim() || "";
                            if (t.includes("Local Guide")) isLocalGuide = true;
                            const m = t.match(/(\d+)\s+review/);
                            if (m) reviewerNumberOfReviews = parseInt(m[1]);
                        }

                        if (stars >= 1 && stars <= 5) {
                            reviews.push({
                                reviewId,
                                name,
                                stars,
                                dateText,
                                text,
                                responseFromOwnerText,
                                responseFromOwnerDate,
                                likesCount,
                                reviewDetailedRating,
                                reviewerNumberOfReviews,
                                isLocalGuide,
                            });
                        }
                    } catch {
                        // Skip malformed cards
                    }
                });

                return reviews;
            });

            log.info(`  Extracted ${pageReviews.length} reviews from DOM`);

            // -----------------------------------------------------------------
            // Process extracted reviews
            // -----------------------------------------------------------------
            for (const rev of pageReviews) {
                if (collectedReviews.length >= maxItems) break;
                const rid = String(rev.reviewId);
                if (seenIds.has(rid)) continue;
                seenIds.add(rid);

                const publishedAtDate = parseRelativeDate(String(rev.dateText || ""));

                collectedReviews.push({
                    reviewId: rid,
                    name: String(rev.name || "Anonymous"),
                    stars: Number(rev.stars),
                    publishedAtDate,
                    text: rev.text ? String(rev.text) : null,
                    reviewUrl: null,
                    responseFromOwnerText: rev.responseFromOwnerText ? String(rev.responseFromOwnerText) : null,
                    responseFromOwnerDate: rev.responseFromOwnerDate ? String(rev.responseFromOwnerDate) : null,
                    likesCount: Number(rev.likesCount || 0),
                    reviewDetailedRating: rev.reviewDetailedRating as Record<string, number> | null,
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
