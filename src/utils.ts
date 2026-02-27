/**
 * Parse a relative date string like "2 months ago", "a week ago", etc.
 * into an ISO date string.
 */
export function parseRelativeDate(text: string): string {
    const now = new Date();
    const lower = text.toLowerCase().trim();

    const match = lower.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
    if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        switch (unit) {
            case "second": now.setSeconds(now.getSeconds() - amount); break;
            case "minute": now.setMinutes(now.getMinutes() - amount); break;
            case "hour":   now.setHours(now.getHours() - amount); break;
            case "day":    now.setDate(now.getDate() - amount); break;
            case "week":   now.setDate(now.getDate() - amount * 7); break;
            case "month":  now.setMonth(now.getMonth() - amount); break;
            case "year":   now.setFullYear(now.getFullYear() - amount); break;
        }
        return now.toISOString();
    }

    // "a month ago", "an hour ago", etc.
    const singleMatch = lower.match(/^a[n]?\s+(second|minute|hour|day|week|month|year)\s+ago$/);
    if (singleMatch) {
        const unit = singleMatch[1];
        switch (unit) {
            case "second": now.setSeconds(now.getSeconds() - 1); break;
            case "minute": now.setMinutes(now.getMinutes() - 1); break;
            case "hour":   now.setHours(now.getHours() - 1); break;
            case "day":    now.setDate(now.getDate() - 1); break;
            case "week":   now.setDate(now.getDate() - 7); break;
            case "month":  now.setMonth(now.getMonth() - 1); break;
            case "year":   now.setFullYear(now.getFullYear() - 1); break;
        }
        return now.toISOString();
    }

    return now.toISOString();
}
