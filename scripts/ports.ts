const WORKSPACE_PORT_OFFSETS = {
  web: 0,
  api: 1,
  playwright: 2,
} as const;

const WORKSPACE_PORT_VARIABLES = ["STYAL_WORKSPACE_PORT", "T3CODE_WORKSPACE_PORT"] as const;

type PortEnvironment = Readonly<Record<string, string | undefined>>;
type WorkspaceService = keyof typeof WORKSPACE_PORT_OFFSETS;

export function parsePort(value: string, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${source} must be a valid TCP port, got '${value}'`);
  }
  return port;
}

export function workspacePort(
  service: WorkspaceService,
  env: PortEnvironment = process.env,
): number | undefined {
  for (const variable of WORKSPACE_PORT_VARIABLES) {
    const value = env[variable];
    if (value === undefined) continue;

    const basePort = parsePort(value, variable);
    const offset = WORKSPACE_PORT_OFFSETS[service];
    const source = offset === 0 ? variable : `${variable} + ${offset}`;
    return parsePort(String(basePort + offset), source);
  }
  return undefined;
}
