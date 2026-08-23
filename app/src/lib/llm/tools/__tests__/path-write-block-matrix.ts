export interface PathWriteBlockedCase {
  program: PathWriteBlockedProgram;
  shape: string;
  command: string;
}

export type PathWriteBlockedProgram = "mkdir" | "touch" | "cp" | "mv" | "sed";

const PROGRAMS: PathWriteBlockedProgram[] = ["mkdir", "touch", "cp", "mv", "sed"];

const COMMON_SHAPES: Array<{ shape: string; build: (program: PathWriteBlockedProgram) => string }> = [
  { shape: "bare", build: (program) => program },
  { shape: "single operand", build: (program) => `${program} /tmp/out` },
  { shape: "double dash single operand", build: (program) => `${program} -- /tmp/out` },
  { shape: "standalone double dash", build: (program) => `${program} --` },
  { shape: "unknown flag", build: (program) => `${program} --not-a-real-flag /tmp/out` },
  { shape: "stdin", build: (program) => `${program} -` },
  { shape: "glob", build: (program) => `${program} *.txt` },
  { shape: "response file", build: (program) => `${program} @args.rsp` },
  { shape: "leading environment assignment", build: (program) => `FOO=bar ${program} /tmp/out` },
  { shape: "quoted program", build: (program) => `"${program}" /tmp/out` },
  { shape: "escaped program", build: (program) => `${program[0]}\\${program.slice(1)} /tmp/out` },
  { shape: "shell pipe", build: (program) => `${program} /tmp/out | echo` },
  { shape: "redirect", build: (program) => `${program} /tmp/out > /tmp/result` },
  { shape: "command substitution", build: (program) => `${program} $(pwd)` },
  { shape: "outside path", build: (program) => `${program} /tmp/outside` },
];

const PROGRAM_SHAPES = {
  mkdir: [
    ...COMMON_SHAPES.map(({ shape, build }) => ({ shape, command: build("mkdir") })),
    { shape: "parents", command: "mkdir -p /tmp/out" },
    { shape: "mode", command: "mkdir -m 755 /tmp/out" },
    { shape: "multiple operands", command: "mkdir /tmp/a /tmp/b" },
    { shape: "parent traversal", command: "mkdir ../outside" },
  ],
  touch: [
    ...COMMON_SHAPES.map(({ shape, build }) => ({ shape, command: build("touch") })),
    { shape: "existing file", command: "touch existing.txt" },
    { shape: "no create", command: "touch -c /tmp/out" },
    { shape: "reference timestamp", command: "touch -r reference.txt /tmp/out" },
    { shape: "date timestamp", command: "touch -d yesterday /tmp/out" },
  ],
  cp: [
    ...COMMON_SHAPES.map(({ shape, build }) => ({ shape, command: build("cp") })),
    { shape: "normal copy", command: "cp source.txt /tmp/out" },
    { shape: "recursive", command: "cp -R source /tmp/out" },
    { shape: "archive", command: "cp -a source /tmp/out" },
    { shape: "multiple source", command: "cp source-a source-b /tmp/out" },
  ],
  mv: [
    ...COMMON_SHAPES.map(({ shape, build }) => ({ shape, command: build("mv") })),
    { shape: "normal move", command: "mv source.txt /tmp/out" },
    { shape: "no clobber", command: "mv -n source.txt /tmp/out" },
    { shape: "interactive", command: "mv -i source.txt /tmp/out" },
    { shape: "multiple source", command: "mv source-a source-b /tmp/out" },
  ],
  sed: [
    ...COMMON_SHAPES.map(({ shape, build }) => ({ shape, command: build("sed") })),
    { shape: "in place", command: "sed -i 's/a/b/' file.txt" },
    { shape: "in place backup", command: "sed -i.bak 's/a/b/' file.txt" },
    { shape: "execute command", command: "sed -e 'e sh' file.txt" },
    { shape: "read command", command: "sed -e 'r /etc/passwd' file.txt" },
    { shape: "write command", command: "sed -e 'w written.txt' file.txt" },
    { shape: "script file", command: "sed -f script.sed file.txt" },
    { shape: "multiple expressions", command: "sed -e 's/a/b/' -e 's/c/d/' file.txt" },
  ],
} satisfies Record<PathWriteBlockedProgram, readonly { shape: string; command: string }[]>;

export const PATH_WRITE_BLOCKED_CASES: readonly PathWriteBlockedCase[] = [
  ...PROGRAMS.flatMap((program) => PROGRAM_SHAPES[program].map(({ shape, command }) => ({ program, shape, command }))),
];
