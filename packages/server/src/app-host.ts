const UUID_V4 =
  /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.localhost:(?<port>[1-9]\d{0,4})$/u;

/** App and control listeners must never share Host authorization. */
export function deploymentIdFromHost(host: string | undefined, port: number) {
  if (host === undefined) {
    return undefined;
  }
  const match = UUID_V4.exec(host);
  return match?.groups?.port === String(port) ? match.groups.id : undefined;
}
