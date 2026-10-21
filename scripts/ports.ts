const T3_WORKSPACE_PORT_OFFSETS = {
  web: 0,
  api: 1,
  playwright: 2,
} as const;

type PortEnvironment = Readonly<Record<string, string | undefined>>;
type T3WorkspaceService = keyof typeof T3_WORKSPACE_PORT_OFFSETS;

export function parsePort(value: string, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${source} must be a valid TCP port, got '${value}'`);
  }
  return port;
}

export function t3WorkspacePort(
  service: T3WorkspaceService,
  env: PortEnvironment = process.env,
): number | undefined {
  const value = env.T3CODE_WORKSPACE_PORT;
  if (value === undefined) return undefined;

  const basePort = parsePort(value, "T3CODE_WORKSPACE_PORT");
  const offset = T3_WORKSPACE_PORT_OFFSETS[service];
  const source = offset === 0 ? "T3CODE_WORKSPACE_PORT" : `T3CODE_WORKSPACE_PORT + ${offset}`;
  return parsePort(String(basePort + offset), source);
}
