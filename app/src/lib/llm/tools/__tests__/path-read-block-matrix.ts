export interface PathReadBlockedCase {
  program: "cat" | "head" | "tail" | "wc";
  shape: string;
  command: string;
}

const PROGRAMS: PathReadBlockedCase["program"][] = ["cat", "head", "tail", "wc"];

const COMMON_FLAG_COMMANDS: Record<PathReadBlockedCase["program"], string> = {
  cat: "cat -n package.json",
  head: "head -n 5 package.json",
  tail: "tail -n 5 package.json",
  wc: "wc -l package.json",
};

const SHAPES: Array<{ shape: string; build: (program: PathReadBlockedCase["program"]) => string }> = [
  { shape: "bare", build: (program) => program },
  { shape: "single operand", build: (program) => `${program} package.json` },
  { shape: "multiple operands", build: (program) => `${program} package.json README.md` },
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

export const PATH_READ_BLOCKED_CASES: readonly PathReadBlockedCase[] = PROGRAMS.flatMap((program) =>
  SHAPES.map(({ shape, build }) => ({ program, shape, command: build(program) })),
);
