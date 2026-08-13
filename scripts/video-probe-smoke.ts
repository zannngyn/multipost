import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePinoLogger } from "@/adapters/logging/pino-logger";
import { makeFfprobeMediaProbe } from "@/adapters/media/ffprobe-probe";
import { AppError } from "@/core/domain/errors";
import {
  evaluateVideoSpec,
  type VideoSpec,
  type VideoSpecVerdict,
  type VideoTarget,
} from "@/core/domain/video-spec";

/**
 * E3 Phase 2 live smoke test of the video spec gate.
 *
 * Runs against REAL ffmpeg/ffprobe binaries — the host does not have them, so:
 *
 *   docker run --rm -v $PWD:/app -w /app node:22-alpine sh -c \
 *     "apk add --no-cache ffmpeg >/dev/null && corepack enable && \
 *      pnpm exec tsx scripts/video-probe-smoke.ts"
 *
 * It synthesises four inputs (three clips + one text file pretending to be a
 * video), probes each one for real, checks the verdicts against what the rule
 * table promises, and captures the raw ffprobe JSON that backs the unit tests
 * in src/adapters/media/__fixtures__/ — so those tests run on output a real
 * ffprobe produced instead of something hand-written.
 *
 * Fixtures are written to a TEMP directory by default and compared against the
 * committed copies; a difference is printed as a diff and does not touch the
 * repo. Pass `--write-fixtures` to actually refresh the committed files, which
 * makes regenerating them a deliberate act with a reviewable diff instead of a
 * side effect of running a smoke test.
 *
 * Exit code 1 on the first mismatch: a green run is the evidence, not the log.
 */

const REPO_FIXTURE_DIR = join(process.cwd(), "src/adapters/media/__fixtures__");
/** `--write-fixtures` (or WRITE_FIXTURES=1) refreshes the committed files. */
const WRITE_FIXTURES =
  process.argv.includes("--write-fixtures") || process.env.WRITE_FIXTURES === "1";

interface Case {
  readonly id: string;
  readonly fileName: string;
  /** ffmpeg arguments producing the clip. */
  readonly ffmpegArgs: (path: string) => string[];
  /** Target -> expected outcome. `true` = ok, otherwise the expected rules. */
  readonly expect: Partial<Record<VideoTarget, true | readonly string[]>>;
}

const CASES: readonly Case[] = [
  {
    id: "feed-16x9-5s",
    fileName: "feed-16x9-5s.mp4",
    ffmpegArgs: (path) => [
      ...synthArgs({ size: "1280x720", seconds: 5, fps: 30 }),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    // Landscape 16:9 is a valid feed video and an invalid Reel (aspect +
    // resolution both fail).
    expect: { facebook_video: true, facebook_reels: ["RESOLUTION_MIN", "ASPECT_RATIO"] },
  },
  {
    id: "reels-9x16-10s",
    fileName: "reels-9x16-10s.mp4",
    ffmpegArgs: (path) => [
      ...synthArgs({ size: "1080x1920", seconds: 10, fps: 30 }),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    expect: { facebook_video: true, facebook_reels: true },
  },
  {
    id: "reels-too-short-2s",
    fileName: "reels-too-short-2s.mov",
    ffmpegArgs: (path) => [
      ...synthArgs({ size: "1080x1920", seconds: 2, fps: 30 }),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    // Same clip: fine as a feed video (min 1s), too short for Reels (min 3s).
    expect: { facebook_video: true, facebook_reels: ["DURATION_MIN"] },
  },
];

function synthArgs(options: { size: string; seconds: number; fps: number }): string[] {
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${options.size}:rate=${options.fps}:duration=${options.seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${options.seconds}`,
    "-t",
    String(options.seconds),
  ];
}

async function main(): Promise<void> {
  const logger = makePinoLogger({ level: "info", pretty: true, base: { service: "video-smoke" } });
  const probe = makeFfprobeMediaProbe({ logger });
  const workDir = mkdtempSync(join(tmpdir(), "mysp-video-smoke-"));
  const fixtureOutDir = WRITE_FIXTURES ? REPO_FIXTURE_DIR : join(workDir, "__fixtures__");
  mkdirSync(fixtureOutDir, { recursive: true });
  console.log(
    WRITE_FIXTURES
      ? `fixtures: refreshing the committed copies in ${REPO_FIXTURE_DIR}`
      : `fixtures: writing to ${fixtureOutDir} (repo untouched; pass --write-fixtures to update)`,
  );

  const failures: string[] = [];
  let fixturesChanged = 0;

  for (const testCase of CASES) {
    const path = join(workDir, testCase.fileName);
    runFfmpeg(testCase.ffmpegArgs(path));
    if (writeFixture(testCase.id, path, fixtureOutDir)) fixturesChanged += 1;

    const spec = await probe.probeVideo({ kind: "path", path });
    console.log(`\n[${testCase.id}] ${describeSpec(spec)}`);

    for (const [target, expected] of Object.entries(testCase.expect) as [
      VideoTarget,
      true | readonly string[],
    ][]) {
      const verdict = evaluateVideoSpec(spec, target);
      console.log(`  ${target}: ${describeVerdict(verdict)}`);
      const problem = compare(verdict, expected);
      if (problem) failures.push(`[${testCase.id}] ${target}: ${problem}`);
    }
  }

  // --- The file that is not a video ----------------------------------------
  const fakePath = join(workDir, "not-a-video.txt");
  writeFileSync(fakePath, "MG0AC6017-KEM (1) — this is a text file, not a clip\n");
  try {
    const spec = await probe.probeVideo({ kind: "path", path: fakePath });
    failures.push(`[not-a-video] expected a probe failure, got ${describeSpec(spec)}`);
  } catch (error) {
    if (!AppError.is(error)) {
      failures.push(`[not-a-video] expected an AppError, got ${String(error)}`);
    } else {
      console.log(
        `\n[not-a-video] blocked as expected: code=${error.code} reason=${String(error.context.reason)}`,
      );
      console.log(`  userMessage: ${error.userMessage}`);
      console.log(`  context: ${JSON.stringify(error.context)}`);
      if (error.code !== "INVALID_INPUT") {
        failures.push(`[not-a-video] expected code INVALID_INPUT, got ${error.code}`);
      }
    }
  }

  // --- ffprobe missing ------------------------------------------------------
  const brokenProbe = makeFfprobeMediaProbe({ logger, ffprobePath: "ffprobe-does-not-exist" });
  try {
    await brokenProbe.probeVideo({ kind: "path", path: join(workDir, CASES[0].fileName) });
    failures.push("[missing-binary] expected a probe failure, got a spec");
  } catch (error) {
    const appError = AppError.is(error) ? error : null;
    const reason = appError ? String(appError.context.reason) : "(not an AppError)";
    console.log(`\n[missing-binary] ${appError?.code ?? "?"} reason=${reason}`);
    if (reason !== "FFPROBE_NOT_AVAILABLE") {
      failures.push(`[missing-binary] expected FFPROBE_NOT_AVAILABLE, got ${reason}`);
    }
  }

  console.log("");
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK — ${CASES.length} clips probed, fixtures written to ${fixtureOutDir}`);
  if (fixturesChanged > 0 && !WRITE_FIXTURES) {
    console.log(
      `NOTE: ${fixturesChanged} fixture(s) differ from the committed copies (diff above). ` +
        "Re-run with --write-fixtures if the new output is the one you want to keep.",
    );
  }
}

/**
 * Runs the raw ffprobe command and stores stdout as a unit-test fixture in
 * `outDir`. Returns true when the output differs from the committed copy — the
 * diff is printed, because a silently rewritten fixture is a test that grades
 * its own homework (ffprobe/ffmpeg versions change the JSON).
 */
function writeFixture(id: string, path: string, outDir: string): boolean {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for fixture ${id}: ${result.stderr}`);
  }
  // The absolute temp path would change on every run — keep the diff stable.
  const stable = result.stdout.replaceAll(path, `/tmp/${id}`);
  const fileName = `${id}.ffprobe.json`;
  const outPath = join(outDir, fileName);
  const committedPath = join(REPO_FIXTURE_DIR, fileName);

  let committed: string | null = null;
  if (existsSync(committedPath)) {
    try {
      committed = readFileSync(committedPath, "utf8");
    } catch (error) {
      // Unreadable committed fixture must not hide the comparison result.
      console.warn(`[${id}] cannot read the committed fixture: ${String(error)}`);
    }
  }

  writeFileSync(outPath, stable);

  if (committed === null) {
    console.log(`[${id}] no committed fixture yet -> ${outPath}`);
    return true;
  }
  if (committed === stable) {
    console.log(`[${id}] fixture matches the committed copy`);
    return false;
  }

  console.log(`[${id}] fixture DIFFERS from the committed copy:`);
  printDiff(committedPath, outPath, stable, committed);
  return true;
}

/** `diff -u` when the tool is there; a byte/line summary when it is not. */
function printDiff(
  committedPath: string,
  candidatePath: string,
  candidate: string,
  committed: string,
): void {
  const diff = spawnSync("diff", ["-u", committedPath, candidatePath], { encoding: "utf8" });
  if (diff.error || typeof diff.stdout !== "string" || diff.stdout.length === 0) {
    console.log(
      `  (no diff tool) committed ${committed.length} bytes / ${committed.split("\n").length} lines vs ` +
        `new ${candidate.length} bytes / ${candidate.split("\n").length} lines`,
    );
    return;
  }
  console.log(
    diff.stdout
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
}

function runFfmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("ffmpeg not found — run this script inside the container (see file header)");
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr?.slice(-500)}`);
  }
}

function describeSpec(spec: VideoSpec): string {
  return [
    `container=${spec.container}`,
    `v=${spec.videoCodec}`,
    `a=${spec.audioCodec ?? "none"}`,
    `${spec.width}x${spec.height}`,
    `${spec.durationSec.toFixed(2)}s`,
    `${spec.sizeBytes}B`,
    `${spec.fps ?? "?"}fps`,
    `rot=${spec.rotationDegrees ?? 0}`,
  ].join(" ");
}

function describeVerdict(verdict: VideoSpecVerdict): string {
  if (verdict.ok) {
    return `PASS${verdict.warnings.length > 0 ? ` (warnings: ${verdict.warnings.join(" | ")})` : ""}`;
  }
  return `BLOCKED ${verdict.violations.map((violation) => `${violation.rule}: ${violation.userMessage}`).join(" | ")}`;
}

function compare(verdict: VideoSpecVerdict, expected: true | readonly string[]): string | null {
  if (expected === true) {
    return verdict.ok ? null : `expected PASS, got ${verdict.violations.map((v) => v.rule).join(",")}`;
  }
  if (verdict.ok) return `expected ${expected.join(",")}, got PASS`;
  const actual = verdict.violations.map((violation) => violation.rule).sort();
  const wanted = [...expected].sort();
  return actual.join(",") === wanted.join(",")
    ? null
    : `expected ${wanted.join(",")}, got ${actual.join(",")}`;
}

main().catch((error: unknown) => {
  console.error(AppError.is(error) ? JSON.stringify(error.toLogObject(), null, 2) : error);
  process.exitCode = 1;
});
