import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
 * table promises, and writes the raw ffprobe JSON into
 * src/adapters/media/__fixtures__/ so the unit tests run on output a real
 * ffprobe produced instead of something hand-written.
 *
 * Exit code 1 on the first mismatch: a green run is the evidence, not the log.
 */

const FIXTURE_DIR = join(process.cwd(), "src/adapters/media/__fixtures__");

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
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const failures: string[] = [];

  for (const testCase of CASES) {
    const path = join(workDir, testCase.fileName);
    runFfmpeg(testCase.ffmpegArgs(path));
    writeFixture(testCase.id, path);

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
  console.log(`OK — ${CASES.length} clips probed, fixtures written to ${FIXTURE_DIR}`);
}

/** Runs the raw ffprobe command and stores stdout as a unit-test fixture. */
function writeFixture(id: string, path: string): void {
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
  writeFileSync(join(FIXTURE_DIR, `${id}.ffprobe.json`), stable);
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
