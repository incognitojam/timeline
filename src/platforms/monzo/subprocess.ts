const FAILURE_PREFIX = "TIMELINE_MONZO_FAILURE ";

export function reportMonzoFailure(error: unknown): void {
  console.error(FAILURE_PREFIX + JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
  }));
}

export function readMonzoFailure(stderr: string, stdout: string, exitCode: number): string {
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(FAILURE_PREFIX)) continue;
    try {
      const failure: unknown = JSON.parse(line.slice(FAILURE_PREFIX.length));
      if (typeof failure === "object" && failure !== null &&
          "message" in failure && typeof failure.message === "string") {
        return failure.message;
      }
    } catch {
      // Keep the complete diagnostic if a child cannot report a valid record.
    }
  }
  const diagnostic = stderr.trim() || stdout.trim();
  const limit = 8192;
  if (diagnostic.length > limit) {
    return diagnostic.slice(0, limit / 2) + "\n… output truncated …\n" + diagnostic.slice(-limit / 2);
  }
  return diagnostic || `Process exited with code ${exitCode}`;
}
