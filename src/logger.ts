type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
