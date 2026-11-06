/**
 * Get Google Takeout services present in extracted files
 */
export function detectTakeoutServices(files: string[]): string[] {
  const services: Set<string> = new Set();

  for (const file of files) {
    const lower = file.toLowerCase();

    if (lower.includes("/youtube/")) services.add("youtube");
    if (lower.includes("/chrome/")) services.add("chrome");
    if (lower.includes("/google keep/") || lower.includes("/keep/"))
      services.add("keep");
    if (lower.includes("/calendar/")) services.add("calendar");
    if (
      lower.includes("/location history/") ||
      lower.includes("/semantic location history/") ||
      lower.includes("records.json")
    )
      services.add("location");
    if (lower.includes("/google chat/") || lower.includes("/chat/"))
      services.add("chat");
    if (lower.includes("/my activity/") && lower.includes("search"))
      services.add("search");
    if (lower.includes("/fit/")) services.add("fit");
    if (lower.includes("/fitbit/")) services.add("fitbit");
    if (lower.includes("timeline.json")) services.add("timeline");
  }

  return Array.from(services);
}
