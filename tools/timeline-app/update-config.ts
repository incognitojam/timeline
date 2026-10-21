export function readUpdateConfig(env: NodeJS.ProcessEnv) {
  const feed = env.TIMELINE_UPDATE_FEED_URL;
  const key = env.TIMELINE_UPDATE_PUBLIC_KEY;
  if (!feed && !key) return null;
  if (!feed || !key) throw new Error("Set both TIMELINE_UPDATE_FEED_URL and TIMELINE_UPDATE_PUBLIC_KEY to enable native updates");
  const url = new URL(feed);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("The update feed must be an HTTPS URL without credentials or a fragment");
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== key) {
    throw new Error("The update public key must be a base64-encoded 32-byte Ed25519 key");
  }
  return { feed: url.href, key };
}

export function releaseURLFromRemote(remote: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match?.[1]) throw new Error("The app's release repository must be a GitHub HTTPS or SSH remote");
  return `https://github.com/${match[1]}/releases`;
}

if (import.meta.main) {
  const plist = process.argv[2];
  if (!plist) throw new Error("Usage: bun update-config.ts <Info.plist>");
  const config = readUpdateConfig(process.env);
  const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
  if (remote.exitCode !== 0) throw new Error("Could not read the release repository from origin");
  const releaseURL = releaseURLFromRemote(remote.stdout.toString().trim());
  const releaseResult = Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", `Add :TimelineReleaseURL string ${releaseURL}`, plist]);
  if (releaseResult.exitCode !== 0) throw new Error("Could not configure the release download URL");
  if (config) {
    for (const [name, type, value] of [
      ["SUFeedURL", "string", config.feed],
      ["SUPublicEDKey", "string", config.key],
      ["SUEnableAutomaticChecks", "bool", "true"],
      ["SUAutomaticallyUpdate", "bool", "false"],
    ]) {
      const result = Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", `Add :${name} ${type} ${value}`, plist]);
      if (result.exitCode !== 0) throw new Error(`Could not configure updater property ${name}`);
    }
    console.log("Native updates enabled; installations require user confirmation.");
  } else {
    console.log("Native updates disabled; the menu opens GitHub downloads.");
  }
}
