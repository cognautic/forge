export interface ParsedArgs {
  command: string;
  subcommand?: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgv(argv: string[]): ParsedArgs {
  const [command = "help", subcommand, ...tail] = argv;
  const rest: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tail.length; i++) {
    const t = tail[i];
    if (t.startsWith("--")) {
      const [k, v] = t.replace(/^--/, "").split("=");
      if (typeof v !== "undefined") {
        flags[k] = v;
      } else if (tail[i + 1] && !tail[i + 1].startsWith("--")) {
        flags[k] = tail[i + 1];
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      rest.push(t);
    }
  }

  return { command, subcommand, rest, flags };
}
