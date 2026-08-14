/** Canonical command-program classification used by the command policy. */
export type CommandClass =
  | "pure-read"
  | "path-read"
  | "path-write"
  | "dynamic-exec"
  | "network"
  | "unsupported";

const programs = {
  pnpm: "dynamic-exec", npm: "dynamic-exec", yarn: "dynamic-exec", node: "dynamic-exec", npx: "dynamic-exec",
  git: "dynamic-exec", tsc: "dynamic-exec", vitest: "dynamic-exec", jest: "dynamic-exec", eslint: "dynamic-exec", prettier: "dynamic-exec",
  python: "dynamic-exec", python3: "dynamic-exec", pip: "dynamic-exec", pip3: "dynamic-exec", cargo: "dynamic-exec", go: "dynamic-exec",
  make: "dynamic-exec", cmake: "dynamic-exec", ninja: "dynamic-exec", gcc: "dynamic-exec", "g++": "dynamic-exec", cc: "dynamic-exec", clang: "dynamic-exec", "clang++": "dynamic-exec", rustc: "dynamic-exec",
  java: "dynamic-exec", javac: "dynamic-exec", mvn: "dynamic-exec", gradle: "dynamic-exec", kotlin: "dynamic-exec", kotlinc: "dynamic-exec",
  ruby: "dynamic-exec", gem: "dynamic-exec", bundle: "dynamic-exec", php: "dynamic-exec", composer: "dynamic-exec", bun: "dynamic-exec", deno: "dynamic-exec", dotnet: "dynamic-exec", swift: "dynamic-exec", perl: "dynamic-exec",
  docker: "dynamic-exec", "docker-compose": "dynamic-exec", podman: "dynamic-exec", kubectl: "dynamic-exec",
  pytest: "dynamic-exec", ruff: "dynamic-exec", mypy: "dynamic-exec", black: "dynamic-exec", flake8: "dynamic-exec", poetry: "dynamic-exec", uv: "dynamic-exec", uvx: "dynamic-exec", pyright: "dynamic-exec",
  bash: "dynamic-exec", sh: "dynamic-exec", zsh: "dynamic-exec",
  pwd: "pure-read", echo: "pure-read", basename: "pure-read", dirname: "pure-read",
  ls: "path-read", cat: "path-read", head: "path-read", tail: "path-read", wc: "path-read", grep: "path-read", rg: "path-read", find: "path-read", sort: "path-read", uniq: "path-read", cut: "path-read", column: "path-read", comm: "path-read", paste: "path-read", nl: "path-read", diff: "path-read", cmp: "path-read", file: "path-read", stat: "path-read", tree: "path-read", du: "path-read", realpath: "path-read", readlink: "path-read", jq: "path-read",
  sed: "path-write", mkdir: "path-write", touch: "path-write", cp: "path-write", mv: "path-write", tar: "path-write", zip: "path-write", unzip: "path-write", gzip: "path-write", gunzip: "path-write",
  curl: "network", wget: "network",
  cd: "unsupported", which: "unsupported", type: "unsupported", date: "unsupported", seq: "unsupported", tr: "unsupported", awk: "unsupported",
} as const satisfies Record<string, CommandClass>;

export type CommandProgram = keyof typeof programs;
export const COMMAND_PROGRAM_SPECS: Readonly<Record<CommandProgram, CommandClass>> = Object.freeze(programs);

export function getCommandClass(program: string): CommandClass | undefined {
  return COMMAND_PROGRAM_SPECS[program as CommandProgram];
}

export function isKnownCommandProgram(program: string): program is CommandProgram {
  return Object.prototype.hasOwnProperty.call(COMMAND_PROGRAM_SPECS, program);
}
