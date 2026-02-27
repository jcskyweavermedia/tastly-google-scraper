export interface GoogleScraperInput {
    startUrls: { url: string }[];
    maxItems?: number;
}

export interface GoogleReview {
    reviewId: string;
    name: string;
    stars: number;
    publishedAtDate: string;
    text: string | null;
    reviewUrl: string | null;
    responseFromOwnerText: string | null;
    responseFromOwnerDate: string | null;
    likesCount: number;
    reviewDetailedRating: Record<string, number> | null;
    reviewerNumberOfReviews: number | null;
    isLocalGuide: boolean;
    language: string;
    reviewOrigin: string;
}
