type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const color = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function now(): string {
  const date = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function paint(level: Level, message: string): string {
  if (level === "INFO") {
    return `${color.blue}${message}${color.reset}`;
  }
  if (level === "WARN") {
    return `${color.yellow}${message}${color.reset}`;
  }
  if (level === "ERROR") {
    return `${color.red}${message}${color.reset}`;
  }
  return `${color.gray}${message}${color.reset}`;
}

function log(level: Level, message: string): void {
  const base = `${now()} | ${level.padEnd(5, " ")} | ${message}`;
  // Keep output concise but readable for batch runs.
  console.log(paint(level, base));
}

function line(char = "-"): void {
  console.log(`${color.gray}${char.repeat(72)}${color.reset}`);
}

export const logger = {
  line,
  section: (title: string): void => {
    line("=");
    console.log(`${color.blue}${title}${color.reset}`);
    line("=");
  },
  info: (message: string): void => log("INFO", message),
  warn: (message: string): void => log("WARN", message),
  error: (message: string): void => log("ERROR", message),
  debug: (message: string): void => log("DEBUG", message),
  success: (message: string): void => {
    const base = `${now()} | OK    | ${message}`;
    console.log(`${color.green}${base}${color.reset}`);
  },
};
