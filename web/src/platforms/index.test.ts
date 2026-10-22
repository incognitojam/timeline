import { PLATFORM_METAS } from "@platforms/metas";
import { SOURCE_REGISTRY } from "@shared/sources";
import { describe, expect, it } from "vitest";
import { getSourceIcon } from "../lib/source-styles";
import * as Icons from "../ui/icons";
import { PLATFORM_DISPLAYS } from ".";

/** Icons as they stood before platforms declared them, plus the retired sources' icons. */
const EXPECTED_ICONS: Record<string, keyof typeof Icons> = {
  amex: "IconAmericanExpress",
  amp: "IconBolt",
  "attachment-descriptions": "IconLabel",
  "auto-detect": "IconAutoAwesome",
  backup: "IconCloudUpload",
  "backup-app-state": "IconCloudUpload",
  "backup-offsite": "IconCloudUpload",
  chatgpt: "IconOpenAI",
  chrome: "IconGoogleChrome",
  claude: "IconClaude",
  "claude-code": "IconClaude",
  codex: "IconOpenAI",
  conductor: "IconAutoAwesome",
  discord: "IconDiscord",
  embeddings: "IconHub",
  facebook: "IconFacebook",
  fitbit: "IconFitbit",
  github: "IconGitHub",
  google: "IconGoogle",
  "google-calendar": "IconGoogleCalendar",
  "google-chat": "IconGoogleChat",
  "google-fit": "IconGoogleFit",
  "google-health": "IconFavorite",
  "google-keep": "IconGoogleKeep",
  "google-location": "IconLocationOn",
  "google-location-sharing": "IconLocationOn",
  "google-messages": "IconGoogleMessages",
  "google-places": "IconGoogleMaps",
  "google-playstore": "IconGooglePlay",
  "google-search": "IconSearch",
  "google-takeout": "IconGoogle",
  "google-timeline": "IconLocationOn",
  "inbox-rclone": "IconInbox",
  instagram: "IconInstagram",
  journal: "IconMenuBook",
  linkedin: "IconLinkedIn",
  live: "IconSimpleSkype",
  manual: "IconEdit",
  "media-evict": "IconDeleteSweep",
  minecraft: "IconMinecraft",
  monzo: "IconMonzo",
  opencode: "IconBuild",
  phone: "IconPhone",
  recall: "IconScreenshotMonitor",
  reddit: "IconReddit",
  "remote-agents": "IconTerminal",
  "render-sweep": "IconCleaningServices",
  skype: "IconSimpleSkype",
  "sms-backup-restore": "IconPhone",
  spotify: "IconSpotify",
  "spotify-friends": "IconSpotify",
  "spotify-playlists": "IconSpotify",
  steam: "IconSteam",
  "steam-friends": "IconSteam",
  swarm: "IconSwarm",
  t3code: "IconCode",
  thriva: "IconBloodtype",
  thumbhash: "IconImage",
  trakt: "IconTrakt",
  wakatime: "IconWakaTime",
  youtube: "IconYouTube",
};

describe("PLATFORM_DISPLAYS", () => {
  it("has one display per platform, in the same order", () => {
    expect(PLATFORM_DISPLAYS.map((display) => display.meta)).toEqual([...PLATFORM_METAS]);
  });

  it("covers exactly the registered sources", () => {
    expect(Object.keys(EXPECTED_ICONS).sort()).toEqual(SOURCE_REGISTRY.map((source) => source.id).sort());
  });

  it.each(Object.entries(EXPECTED_ICONS))("keeps the icon for %s", (source, icon) => {
    expect(getSourceIcon(source)).toBe(Icons[icon]);
  });
});
