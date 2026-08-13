import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { VideoSpec } from "@/core/domain/video-spec";
import type { Logger } from "@/core/ports/infra";
import type { MediaProbe, ProbeSource } from "@/core/ports/media-probe";

/**
 * MediaProbe over the `ffprobe` binary (E3, Phase 2 — docs/02 section 5.4).
 *
 * The binary is spawned directly through node:child_process: no fluent-ffmpeg,
 * no wrapper dependency. The stack document names ffprobe, not a library, and a
 * wrapper would add a dependency for one command line.
 *
 * Nothing ffprobe prints is trusted: stdout goes through a zod schema before a
 * single field becomes a VideoSpec (technical rule 2). Every failure path ends
 * in an AppError carrying exit code / reason / truncated stderr — never a raw
 * spawn error, never a silent default.
 *
 * The binary lives in the worker image (fb-publisher owns the Dockerfile). A web
 * process without ffprobe gets FFPROBE_NOT_AVAILABLE on first use, which the
 * composition root turns into "not checked yet, the worker will check".
 */

/** ffprobe on a 60s clip answers in well under a second; 15s is a hung process. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Guard against an ffprobe that streams megabytes at us (it never should). */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 500;

const FFPROBE_ARGS = [
  "-v",
  "error",
  "-print_format",
  "json",
  "-show_format",
  "-show_streams",
] as const;

// --- ffprobe output schema --------------------------------------------------

/** ffprobe prints numbers as strings in some builds; accept both, coerce later. */
const NumericLike = z.union([z.number(), z.string()]).nullish();

const StreamSchema = z.object({
  codec_type: z.string().nullish(),
  codec_name: z.string().nullish(),
  width: NumericLike,
  height: NumericLike,
  duration: NumericLike,
  r_frame_rate: z.string().nullish(),
  avg_frame_rate: z.string().nullish(),
  /** `attached_pic` marks cover art, which is a video stream but not a video. */
  disposition: z.record(z.string(), z.number()).nullish(),
  tags: z.record(z.string(), z.unknown()).nullish(),
  side_data_list: z
    .array(z.object({ rotation: NumericLike }).loose())
    .nullish(),
});

const FfprobeOutputSchema = z.object({
  streams: z.array(StreamSchema).nullish(),
  format: z
    .object({
      format_name: z.string().nullish(),
      duration: NumericLike,
      size: NumericLike,
    })
    .nullish(),
});

// --- adapter ----------------------------------------------------------------

export interface FfprobeMediaProbeDeps {
  logger: Logger;
  /** Binary path or bare name resolved through PATH. Defaults to "ffprobe". */
  ffprobePath?: string;
  timeoutMs?: number;
}

export function makeFfprobeMediaProbe(deps: FfprobeMediaProbeDeps): MediaProbe {
  const ffprobePath =
    typeof deps?.ffprobePath === "string" && deps.ffprobePath.trim().length > 0
      ? deps.ffprobePath.trim()
      : "ffprobe";
  const timeoutMs =
    typeof deps?.timeoutMs === "number" && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    async probeVideo(source: ProbeSource): Promise<VideoSpec> {
      // --- Edge cases first --------------------------------------------------
      if (!source || (source.kind !== "path" && source.kind !== "bytes")) {
        throw new AppError("INVALID_INPUT", {
          message: "probeVideo requires a { kind: 'path' } or { kind: 'bytes' } source",
          userMessage: "Không xác định được file video cần kiểm tra thông số.",
          context: { reason: "PROBE_SOURCE_INVALID", source_kind: (source as { kind?: unknown })?.kind ?? null },
        });
      }

      if (source.kind === "path") {
        const path = typeof source.path === "string" ? source.path.trim() : "";
        if (path.length === 0) {
          throw new AppError("INVALID_INPUT", {
            message: "probeVideo received an empty path",
            userMessage: "Không xác định được file video cần kiểm tra thông số.",
            context: { reason: "PROBE_SOURCE_INVALID" },
          });
        }
        const sizeBytes = await statSize(path, deps.logger);
        return runProbe({ path, sizeBytes, ffprobePath, timeoutMs, logger: deps.logger });
      }

      if (!(source.bytes instanceof Uint8Array) || source.bytes.byteLength === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "probeVideo received an empty byte buffer",
          userMessage: "File video rỗng hoặc tải về không thành công — chưa kiểm tra được thông số.",
          context: { reason: "PROBE_SOURCE_EMPTY", byte_length: source.bytes?.byteLength ?? null },
        });
      }

      const tempPath = await writeTempFile(source.bytes, source.fileName, deps.logger);
      try {
        return await runProbe({
          path: tempPath,
          sizeBytes: source.bytes.byteLength,
          ffprobePath,
          timeoutMs,
          logger: deps.logger,
        });
      } finally {
        // Cleanup failure is logged with context but deliberately NOT rethrown:
        // it must not hide a probe result (or mask the probe's own error). A
        // leaked temp file is an ops nuisance, not a business failure.
        await unlink(tempPath).catch((error: unknown) => {
          deps.logger.warn("Failed to delete ffprobe temp file", {
            error_code: "INTERNAL",
            reason: "TEMP_FILE_CLEANUP_FAILED",
            temp_path: tempPath,
            err: error,
          });
        });
      }
    },
  };
}

// --- internals --------------------------------------------------------------

interface RunProbeInput {
  path: string;
  sizeBytes: number | null;
  ffprobePath: string;
  timeoutMs: number;
  logger: Logger;
}

async function runProbe(input: RunProbeInput): Promise<VideoSpec> {
  const started = Date.now();
  const result = await spawnFfprobe(input);
  const durationMs = Date.now() - started;

  if (result.spawnError) {
    const code = (result.spawnError as NodeJS.ErrnoException).code;
    const missing = code === "ENOENT";
    throw new AppError("INTERNAL", {
      message: missing
        ? `ffprobe binary not found at '${input.ffprobePath}'`
        : `Failed to spawn ffprobe: ${String(result.spawnError)}`,
      userMessage: missing
        ? "Máy chủ chưa cài ffprobe nên chưa kiểm tra được thông số video."
        : "Không chạy được công cụ kiểm tra video. Vui lòng thử lại sau ít phút.",
      context: {
        reason: missing ? "FFPROBE_NOT_AVAILABLE" : "FFPROBE_SPAWN_FAILED",
        ffprobe_path: input.ffprobePath,
        spawn_error_code: code ?? null,
      },
      cause: result.spawnError,
    });
  }

  if (result.timedOut) {
    throw new AppError("INTERNAL", {
      message: `ffprobe timed out after ${input.timeoutMs}ms`,
      userMessage: "Kiểm tra thông số video quá thời gian cho phép. Vui lòng thử lại.",
      context: { reason: "FFPROBE_TIMEOUT", timeout_ms: input.timeoutMs, duration_ms: durationMs },
    });
  }

  if (result.exitCode !== 0) {
    // ffprobe exits non-zero on "not a media file", truncated downloads and
    // unreadable containers alike — a data problem, not a system fault.
    throw new AppError("INVALID_INPUT", {
      message: `ffprobe exited with code ${result.exitCode}`,
      userMessage: "File này không phải video hợp lệ hoặc đã hỏng — không kiểm tra được thông số.",
      context: {
        reason: "FFPROBE_EXIT_NONZERO",
        exit_code: result.exitCode,
        stderr: truncate(result.stderr, MAX_STDERR_CHARS),
        duration_ms: durationMs,
      },
    });
  }

  return mapOutput(result.stdout, input);
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: Error | null;
}

function spawnFfprobe(input: RunProbeInput): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(input.ffprobePath, [...FFPROBE_ARGS, input.path], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    const settle = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS * 4) stderr += chunk.toString("utf8");
    });

    child.on("error", (error: Error) => {
      settle({ exitCode: null, stdout, stderr, timedOut, spawnError: error });
    });
    child.on("close", (code) => {
      settle({ exitCode: code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

/** Parses + validates ffprobe stdout and maps it onto the domain VideoSpec. */
export function mapOutput(stdout: string, input: Pick<RunProbeInput, "path" | "sizeBytes">): VideoSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new AppError("INVALID_INPUT", {
      message: "ffprobe stdout is not valid JSON",
      userMessage: "Không đọc được thông số video trả về từ công cụ kiểm tra.",
      context: {
        reason: "FFPROBE_OUTPUT_INVALID",
        stdout_head: truncate(stdout, 200),
        file_path: input.path,
      },
      cause: error,
    });
  }

  const parsed = FfprobeOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("INVALID_INPUT", {
      message: "ffprobe output failed schema validation",
      userMessage: "Không đọc được thông số video trả về từ công cụ kiểm tra.",
      context: {
        reason: "FFPROBE_OUTPUT_INVALID",
        issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"),
        file_path: input.path,
      },
    });
  }

  const streams = parsed.data.streams ?? [];
  const videoStream = streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  if (!videoStream) {
    throw new AppError("INVALID_INPUT", {
      message: "File has no usable video stream",
      userMessage: "File này không chứa luồng video — không dùng làm bài video được.",
      context: {
        reason: "NOT_A_VIDEO",
        stream_types: streams.map((stream) => stream.codec_type ?? "unknown"),
        file_path: input.path,
      },
    });
  }

  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const width = toNumber(videoStream.width);
  const height = toNumber(videoStream.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new AppError("INVALID_INPUT", {
      message: "ffprobe reported no usable frame size",
      userMessage: "Không đọc được kích thước khung hình của video.",
      context: { reason: "FFPROBE_OUTPUT_INVALID", width, height, file_path: input.path },
    });
  }

  const durationSec = toNumber(parsed.data.format?.duration) ?? toNumber(videoStream.duration);
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    // A duration-less file cannot be checked against the min/max rules, and
    // guessing "0" would fake a violation. Refuse, name the reason.
    throw new AppError("INVALID_INPUT", {
      message: "ffprobe reported no usable duration",
      userMessage: "Không đọc được thời lượng video — file có thể bị hỏng hoặc tải chưa xong.",
      context: { reason: "MISSING_DURATION", file_path: input.path },
    });
  }

  const rotationDegrees = readRotation(videoStream);
  const swap = rotationDegrees === 90 || rotationDegrees === 270;
  const sizeBytes = toNumber(parsed.data.format?.size) ?? input.sizeBytes ?? 0;

  return {
    container: (parsed.data.format?.format_name ?? "").trim(),
    videoCodec: (videoStream.codec_name ?? "").trim().toLowerCase(),
    audioCodec: audioStream?.codec_name ? audioStream.codec_name.trim().toLowerCase() : null,
    width: swap ? height : width,
    height: swap ? width : height,
    durationSec,
    sizeBytes,
    fps: readFps(videoStream),
    rotationDegrees,
  };
}

type StreamData = z.infer<typeof StreamSchema>;

/**
 * Rotation normalised to 0/90/180/270. A phone .mov stores portrait footage as
 * landscape plus `rotate=90`; without this a valid 9:16 Reel reads as 16:9.
 */
function readRotation(stream: StreamData): number {
  const fromSideData = stream.side_data_list?.map((entry) => toNumber(entry.rotation)).find(
    (value): value is number => value !== null,
  );
  const rawTag = stream.tags?.rotate;
  const fromTag = typeof rawTag === "string" || typeof rawTag === "number" ? toNumber(rawTag) : null;
  const value = fromSideData ?? fromTag ?? 0;
  const normalised = ((Math.round(value) % 360) + 360) % 360;
  return normalised === 90 || normalised === 180 || normalised === 270 ? normalised : 0;
}

/** "30000/1001" -> 29.97. Returns null for "0/0" and other unusable values. */
function readFps(stream: StreamData): number | null {
  return parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate);
}

function parseRational(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) {
    const plain = Number(value);
    return Number.isFinite(plain) && plain > 0 ? plain : null;
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (denominator === 0 || numerator === 0) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function statSize(path: string, logger: Logger): Promise<number | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new AppError("INVALID_INPUT", {
        message: `Probe target is not a file: ${path}`,
        userMessage: "Đường dẫn video không trỏ tới một file.",
        context: { reason: "PROBE_SOURCE_INVALID", file_path: path },
      });
    }
    return info.size;
  } catch (error) {
    if (AppError.is(error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AppError("MEDIA_NOT_FOUND", {
        message: `Video file not found: ${path}`,
        userMessage: "Không tìm thấy file video cần kiểm tra.",
        context: { reason: "PROBE_FILE_MISSING", file_path: path },
        cause: error,
      });
    }
    // Unreadable but present: let ffprobe produce the precise error, keep going.
    logger.warn("Could not stat probe target, falling back to ffprobe-reported size", {
      error_code: "INTERNAL",
      reason: "PROBE_STAT_FAILED",
      file_path: path,
      err: error,
    });
    return null;
  }
}

async function writeTempFile(
  bytes: Uint8Array,
  fileName: string | undefined,
  logger: Logger,
): Promise<string> {
  const extension = extensionOf(fileName);
  const path = join(tmpdir(), `mysp-probe-${randomUUID()}${extension}`);
  try {
    await writeFile(path, bytes);
    return path;
  } catch (error) {
    logger.error("Failed to write ffprobe temp file", {
      error_code: "INTERNAL",
      reason: "TEMP_FILE_WRITE_FAILED",
      temp_path: path,
      byte_length: bytes.byteLength,
      err: error,
    });
    throw new AppError("INTERNAL", {
      message: "Failed to write temporary file for ffprobe",
      userMessage: "Máy chủ không ghi được file tạm để kiểm tra video. Vui lòng thử lại.",
      context: { reason: "TEMP_FILE_WRITE_FAILED", temp_path: path },
      cause: error,
    });
  }
}

/** ffprobe sniffs content, but a plausible extension helps some demuxers. */
function extensionOf(fileName: string | undefined): string {
  if (typeof fileName !== "string") return ".mp4";
  const match = /\.([a-z0-9]{2,4})$/i.exec(fileName.trim());
  return match ? `.${match[1].toLowerCase()}` : ".mp4";
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
