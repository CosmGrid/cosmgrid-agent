export interface PathReadBlockedCase {
  program: PathReadBlockedProgram;
  shape: string;
  command: string;
}

export type PathReadBlockedProgram = "cat" | "head" | "tail" | "wc" | "grep" | "rg";

const PROGRAMS: PathReadBlockedProgram[] = ["cat", "head", "tail", "wc", "grep", "rg"];

const COMMON_FLAG_COMMANDS: Record<PathReadBlockedProgram, string> = {
  cat: "cat -n package.json",
  head: "head -n 5 package.json",
  tail: "tail -n 5 package.json",
  wc: "wc -l package.json",
  grep: "grep -n needle package.json",
  rg: "rg -n needle package.json",
};

const COMMON_SHAPES: Array<{ shape: string; build: (program: PathReadBlockedProgram) => string }> = [
  { shape: "bare", build: (program) => program },
  { shape: "single file", build: (program) => `${program} package.json` },
  { shape: "multiple files", build: (program) => `${program} package.json README.md` },
  { shape: "double dash single operand", build: (program) => `${program} -- package.json` },
  { shape: "double dash multiple operands", build: (program) => `${program} -- package.json README.md` },
  { shape: "standalone double dash", build: (program) => `${program} --` },
  { shape: "common flag", build: (program) => COMMON_FLAG_COMMANDS[program] },
  { shape: "unknown flag", build: (program) => `${program} --not-a-real-flag package.json` },
  { shape: "stdin", build: (program) => `${program} -` },
  { shape: "glob", build: (program) => `${program} *.ts` },
  { shape: "response file", build: (program) => `${program} @args.rsp` },
  { shape: "leading environment assignment", build: (program) => `FOO=bar ${program} package.json` },
  { shape: "quoted program", build: (program) => `"${program}" package.json` },
  { shape: "escaped program", build: (program) => `${program[0]}\\${program.slice(1)} package.json` },
  { shape: "shell pipe", build: (program) => `${program} package.json | echo` },
  { shape: "redirect", build: (program) => `${program} package.json > out.txt` },
  { shape: "command substitution", build: (program) => `${program} $(pwd)` },
];

const PROGRAM_SHAPES = {
  cat: COMMON_SHAPES,
  head: COMMON_SHAPES,
  tail: COMMON_SHAPES,
  wc: COMMON_SHAPES,
  grep: [
    { shape: "bare", command: "grep" },
    { shape: "single file", command: "grep needle package.json" },
    { shape: "multiple files", command: "grep needle package.json README.md" },
    { shape: "double dash single operand", command: "grep -- needle package.json" },
    { shape: "double dash multiple operands", command: "grep -- needle package.json README.md" },
    { shape: "standalone double dash", command: "grep --" },
    { shape: "common flag", command: COMMON_FLAG_COMMANDS.grep },
    { shape: "unknown flag", command: "grep --not-a-real-flag needle package.json" },
    { shape: "stdin", command: "grep needle -" },
    { shape: "glob", command: "grep needle *.ts" },
    { shape: "response file", command: "grep needle @args.rsp" },
    { shape: "leading environment assignment", command: "FOO=bar grep needle package.json" },
    { shape: "quoted program", command: '"grep" needle package.json' },
    { shape: "escaped program", command: "g\\rep needle package.json" },
    { shape: "shell pipe", command: "grep needle package.json | echo" },
    { shape: "redirect", command: "grep needle package.json > out.txt" },
    { shape: "command substitution", command: "grep needle $(pwd)" },
  ],
  rg: [
    { shape: "bare", command: "rg" },
    { shape: "single file", command: "rg needle package.json" },
    { shape: "multiple files", command: "rg needle package.json README.md" },
    { shape: "double dash single operand", command: "rg -- needle package.json" },
    { shape: "double dash multiple operands", command: "rg -- needle package.json README.md" },
    { shape: "standalone double dash", command: "rg --" },
    { shape: "common flag", command: COMMON_FLAG_COMMANDS.rg },
    { shape: "unknown flag", command: "rg --not-a-real-flag needle package.json" },
    { shape: "stdin", command: "rg needle -" },
    { shape: "glob", command: "rg needle *.ts" },
    { shape: "response file", command: "rg needle @args.rsp" },
    { shape: "leading environment assignment", command: "FOO=bar rg needle package.json" },
    { shape: "quoted program", command: '"rg" needle package.json' },
    { shape: "escaped program", command: "r\\g needle package.json" },
    { shape: "shell pipe", command: "rg needle package.json | echo" },
    { shape: "redirect", command: "rg needle package.json > out.txt" },
    { shape: "command substitution", command: "rg needle $(pwd)" },
  ],
} satisfies Record<PathReadBlockedProgram, readonly ({ shape: string; command: string } | { shape: string; build: (program: PathReadBlockedProgram) => string })[]>;

export const PATH_READ_BLOCKED_CASES: readonly PathReadBlockedCase[] = [
  ...PROGRAMS.flatMap((program) =>
    PROGRAM_SHAPES[program].map(({ shape, ...caseDefinition }) => ({
      program,
      shape,
      command: "command" in caseDefinition ? caseDefinition.command : caseDefinition.build(program),
    })),
  ),
  { program: "grep", shape: "pattern file", command: "grep -f patterns.txt package.json" },
  { program: "grep", shape: "recursive exclude file", command: "grep -R --exclude-from=exclude.lst needle ." },
  { program: "rg", shape: "pattern file", command: "rg -f patterns.txt package.json" },
  { program: "rg", shape: "preprocessor", command: "rg --pre \"sh -c 'cat'\" needle ." },
  { program: "rg", shape: "hidden symlink", command: "rg --hidden -L needle ." },
  { program: "rg", shape: "config environment", command: "RIPGREP_CONFIG_PATH=rg.conf rg needle package.json" },
];
