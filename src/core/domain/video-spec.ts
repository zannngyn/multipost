/**
 * Video specification gate (E3, Phase 2).
 * Pure TypeScript: no I/O, no imports outside core/domain (docs/07 section 2).
 *
 * Brief section 5: "Video phải được kiểm tra thông số trước khi tải lên: tỷ lệ
 * khung hình, dung lượng, thời lượng. Không đạt thì báo lỗi trước, không đăng
 * rồi mới lỗi." docs/02 section 5.1 puts this at step 4 — after the stock gate
 * and the media gather, BEFORE the AI call and before a single byte is uploaded.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Meta's public documentation (Page video upload + Facebook Reels API) as known
 * at the assistant knowledge cutoff. Meta changes these silently and the project
 * has no real Page token yet (docs/02 risk R2), so EVERY threshold below is a
 * named constant carrying `// PENDING(video-limits)` and must be re-verified
 * against a live Page before Phase 2 ships. The failure mode of a wrong number
 * here is a blocked post with a precise message, never a silent upload — which
 * is the direction the brief asks us to err in.
 */

import { AppError } from "./errors";

// --- Targets ----------------------------------------------------------------

/**
 * Publishing destination the video must satisfy. Facebook only for Phase 2;
 * TikTok gets its own entries when E12 lands (its limits are different).
 */
export const VIDEO_TARGETS = ["facebook_video", "facebook_reels"] as const;
export type VideoTarget = (typeof VIDEO_TARGETS)[number];

export function isVideoTarget(value: unknown): value is VideoTarget {
  return typeof value === "string" && (VIDEO_TARGETS as readonly string[]).includes(value);
}

/** Vietnamese label used inside operator messages. */
const TARGET_LABELS: Record<VideoTarget, string> = {
  facebook_video: "Video Facebook",
  facebook_reels: "Reels Facebook",
};

// --- The probed facts -------------------------------------------------------

/**
 * What ffprobe could establish about one file. Filled in by an adapter
 * implementing `MediaProbe`; this module never reads a file itself.
 */
export interface VideoSpec {
  /**
   * ffprobe `format.format_name`, which is a comma-separated LIST for the
   * mp4/mov family ("mov,mp4,m4a,3gp,3g2,mj2"). Matching is token based.
   */
  readonly container: string;
  /** ffprobe `codec_name` of the first video stream, e.g. "h264", "hevc". */
  readonly videoCodec: string;
  /** Null when the file carries no audio stream at all. */
  readonly audioCodec: string | null;
  /** DISPLAY width in pixels — rotation metadata already applied by the probe. */
  readonly width: number;
  /** DISPLAY height in pixels — rotation metadata already applied by the probe. */
  readonly height: number;
  readonly durationSec: number;
  readonly sizeBytes: number;
  /** Null when ffprobe reported an unusable frame rate (e.g. "0/0"). */
  readonly fps: number | null;
  /**
   * Rotation from the container metadata (0/90/180/270). Kept for logs: a phone
   * .mov is stored landscape + rotate=90, and forgetting it turns a valid 9:16
   * Reel into a "wrong aspect ratio" rejection (docs/05: real .mov files exist).
   */
  readonly rotationDegrees?: number;
}

// --- Limits -----------------------------------------------------------------

const BYTES_PER_GB = 1_000_000_000; // decimal GB: the stricter reading of "10GB"
const SECONDS_PER_MINUTE = 60;

/** 9:16 portrait = 0.5625, 16:9 landscape = 1.7778. */
export const PORTRAIT_9_16 = 9 / 16;
export const LANDSCAPE_16_9 = 16 / 9;

/**
 * Aspect ratios never land exactly on the ideal (1080x1920 does, 1079x1920 does
 * not, and encoders round). PENDING(video-limits): Meta does not publish its
 * tolerance; 1% is our own allowance and is deliberately narrow.
 */
export const ASPECT_TOLERANCE = 0.01;

export interface VideoTargetLimits {
  /** Accepted container tokens (lower-case, as ffprobe spells them). */
  readonly containers: readonly string[];
  readonly videoCodecs: readonly string[];
  /** Accepted audio codecs. An audio-less file is a warning, never a block. */
  readonly audioCodecs: readonly string[];
  readonly minDurationSec: number;
  readonly maxDurationSec: number;
  readonly maxSizeBytes: number;
  readonly minWidth: number;
  readonly minHeight: number;
  /** Accepted width/height range, inclusive of ASPECT_TOLERANCE. */
  readonly minAspectRatio: number;
  readonly maxAspectRatio: number;
  /** Null = the target does not state a frame-rate bound. */
  readonly minFps: number | null;
  readonly maxFps: number | null;
  /**
   * Recommended SHORT side (720p, 1080p...). Measured on the short side because
   * a target accepts both orientations: 1080x1920 and 1920x1080 are both "1080p"
   * and comparing width to width would flag portrait footage for nothing.
   * Below it the post still goes out, with an internal warning.
   */
  readonly recommendedMinShortSide: number;
}

/**
 * Facebook video post on a Page (Graph API `/videos`).
 * Source: Meta "Video Upload"/Page video docs at knowledge cutoff —
 * max file size 10GB, max length 240 minutes, aspect ratio between 9:16 and
 * 16:9, minimum width 120px, H.264 + AAC recommended.
 * PENDING(video-limits): verify each line on a real Page before Phase 2 ships.
 */
export const FACEBOOK_VIDEO_LIMITS: VideoTargetLimits = {
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc", "h265"],
  audioCodecs: ["aac", "mp3"],
  minDurationSec: 1,
  maxDurationSec: 240 * SECONDS_PER_MINUTE,
  maxSizeBytes: 10 * BYTES_PER_GB,
  minWidth: 120,
  minHeight: 120,
  minAspectRatio: PORTRAIT_9_16,
  maxAspectRatio: LANDSCAPE_16_9,
  minFps: null,
  maxFps: 60,
  recommendedMinShortSide: 720,
};

/**
 * Facebook Reels (Graph API `/video_reels`).
 * Source: Meta Facebook Reels API docs at knowledge cutoff — 9:16 aspect ratio,
 * duration 3s..90s, minimum resolution 540x960 (1080x1920 recommended),
 * frame rate 24..60 fps, maximum file size 1GB, H.264/HEVC + AAC.
 * PENDING(video-limits): the 90s ceiling in particular moved more than once;
 * re-check with the Page test account.
 */
export const FACEBOOK_REELS_LIMITS: VideoTargetLimits = {
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc", "h265"],
  audioCodecs: ["aac", "mp3"],
  minDurationSec: 3,
  maxDurationSec: 90,
  maxSizeBytes: 1 * BYTES_PER_GB,
  minWidth: 540,
  minHeight: 960,
  minAspectRatio: PORTRAIT_9_16,
  maxAspectRatio: PORTRAIT_9_16,
  minFps: 24,
  maxFps: 60,
  recommendedMinShortSide: 1080,
};

export const VIDEO_TARGET_LIMITS: Record<VideoTarget, VideoTargetLimits> = {
  facebook_video: FACEBOOK_VIDEO_LIMITS,
  facebook_reels: FACEBOOK_REELS_LIMITS,
};

// --- Verdict ----------------------------------------------------------------

export const VIDEO_SPEC_RULES = [
  "SPEC_UNREADABLE",
  "CONTAINER",
  "VIDEO_CODEC",
  "DURATION_MIN",
  "DURATION_MAX",
  "FILE_SIZE_MAX",
  "RESOLUTION_MIN",
  "ASPECT_RATIO",
  "FPS_MIN",
  "FPS_MAX",
] as const;
export type VideoSpecRule = (typeof VIDEO_SPEC_RULES)[number];

export interface VideoSpecViolation {
  readonly rule: VideoSpecRule;
  /** Human-readable measured value, e.g. "2,0 giây". */
  readonly actual: string;
  /** Human-readable requirement, e.g. "tối thiểu 3 giây". */
  readonly limit: string;
  /** Vietnamese, shown to the operator — states what is wrong AND what is needed. */
  readonly userMessage: string;
}

export type VideoSpecVerdict =
  | { readonly ok: true; readonly target: VideoTarget; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly target: VideoTarget;
      readonly violations: readonly VideoSpecViolation[];
      readonly warnings: readonly string[];
    };

/**
 * Checks one probed file against one target.
 *
 * Edge cases first: an unknown target is a programming error and throws; an
 * unreadable spec (missing/NaN/negative numbers) is a DATA problem and comes
 * back as a violation, because a corrupt file must block the post rather than
 * crash the batch (business rule 5 — never silently skip, never abort the run).
 *
 * Every failing rule is reported, not just the first: an operator who has to
 * re-export a clip wants the whole list in one go.
 */
export function evaluateVideoSpec(spec: VideoSpec, target: VideoTarget): VideoSpecVerdict {
  if (!isVideoTarget(target)) {
    throw new AppError("INVALID_INPUT", {
      message: `Unknown video target '${String(target)}'`,
      context: { target: String(target), supported: VIDEO_TARGETS },
    });
  }

  const limits = VIDEO_TARGET_LIMITS[target];
  const label = TARGET_LABELS[target];
  const violations: VideoSpecViolation[] = [];
  const warnings: string[] = [];

  const unreadable = describeUnreadable(spec);
  if (unreadable !== null) {
    return {
      ok: false,
      target,
      violations: [
        {
          rule: "SPEC_UNREADABLE",
          actual: unreadable,
          limit: "thông số video đọc được đầy đủ",
          userMessage: `Không đọc được thông số video (${unreadable}) — không đăng ${label} với file này`,
        },
      ],
      warnings,
    };
  }

  // --- container / codecs ---------------------------------------------------
  const containerTokens = tokenize(spec.container);
  if (!containerTokens.some((token) => limits.containers.includes(token))) {
    violations.push({
      rule: "CONTAINER",
      actual: spec.container,
      limit: limits.containers.join(" / "),
      userMessage: `Định dạng file "${spec.container}" không được ${label} hỗ trợ — cần ${limits.containers.join(" hoặc ").toUpperCase()}`,
    });
  }

  const videoCodec = spec.videoCodec.trim().toLowerCase();
  if (!limits.videoCodecs.includes(videoCodec)) {
    violations.push({
      rule: "VIDEO_CODEC",
      actual: videoCodec,
      limit: limits.videoCodecs.join(" / "),
      userMessage: `Video mã hoá bằng codec "${videoCodec}" — ${label} cần ${limits.videoCodecs.join(" hoặc ").toUpperCase()}`,
    });
  }

  // Audio is a warning, not a block: a silent clip still publishes, it just
  // performs badly. Blocking on it would stop posts Facebook itself accepts.
  if (spec.audioCodec === null) {
    warnings.push(`Video không có tiếng — ${label} vẫn đăng được nhưng thường ít tiếp cận hơn`);
  } else if (!limits.audioCodecs.includes(spec.audioCodec.trim().toLowerCase())) {
    warnings.push(
      `Âm thanh dùng codec "${spec.audioCodec}" (khuyến nghị ${limits.audioCodecs.join("/").toUpperCase()}) — nền tảng có thể phải mã hoá lại`,
    );
  }

  // --- duration -------------------------------------------------------------
  if (spec.durationSec < limits.minDurationSec) {
    violations.push({
      rule: "DURATION_MIN",
      actual: formatSeconds(spec.durationSec),
      limit: `tối thiểu ${formatSeconds(limits.minDurationSec)}`,
      userMessage: `Video dài ${formatSeconds(spec.durationSec)} — ${label} yêu cầu tối thiểu ${formatSeconds(limits.minDurationSec)}`,
    });
  }
  if (spec.durationSec > limits.maxDurationSec) {
    violations.push({
      rule: "DURATION_MAX",
      actual: formatSeconds(spec.durationSec),
      limit: `tối đa ${formatSeconds(limits.maxDurationSec)}`,
      userMessage: `Video dài ${formatSeconds(spec.durationSec)} — ${label} chỉ nhận tối đa ${formatSeconds(limits.maxDurationSec)}`,
    });
  }

  // --- file size ------------------------------------------------------------
  if (spec.sizeBytes > limits.maxSizeBytes) {
    violations.push({
      rule: "FILE_SIZE_MAX",
      actual: formatBytes(spec.sizeBytes),
      limit: `tối đa ${formatBytes(limits.maxSizeBytes)}`,
      userMessage: `File nặng ${formatBytes(spec.sizeBytes)} — ${label} chỉ nhận tối đa ${formatBytes(limits.maxSizeBytes)}`,
    });
  }

  // --- resolution + aspect ratio -------------------------------------------
  if (spec.width < limits.minWidth || spec.height < limits.minHeight) {
    violations.push({
      rule: "RESOLUTION_MIN",
      actual: `${spec.width}x${spec.height}`,
      limit: `tối thiểu ${limits.minWidth}x${limits.minHeight}`,
      userMessage: `Độ phân giải ${spec.width}x${spec.height} thấp hơn mức tối thiểu ${limits.minWidth}x${limits.minHeight} của ${label}`,
    });
  } else if (Math.min(spec.width, spec.height) < limits.recommendedMinShortSide) {
    warnings.push(
      `Độ phân giải ${spec.width}x${spec.height} thấp hơn mức khuyến nghị ${limits.recommendedMinShortSide}p của ${label}`,
    );
  }

  const ratio = spec.width / spec.height;
  const minRatio = limits.minAspectRatio * (1 - ASPECT_TOLERANCE);
  const maxRatio = limits.maxAspectRatio * (1 + ASPECT_TOLERANCE);
  if (ratio < minRatio || ratio > maxRatio) {
    const expected =
      limits.minAspectRatio === limits.maxAspectRatio
        ? describeRatio(limits.minAspectRatio)
        : `${describeRatio(limits.minAspectRatio)} đến ${describeRatio(limits.maxAspectRatio)}`;
    violations.push({
      rule: "ASPECT_RATIO",
      actual: `${describeRatio(ratio)} (${spec.width}x${spec.height})`,
      limit: expected,
      userMessage: `Tỷ lệ khung hình ${describeRatio(ratio)} (${spec.width}x${spec.height}) không hợp lệ — ${label} cần tỷ lệ ${expected}`,
    });
  }

  // --- frame rate -----------------------------------------------------------
  if (spec.fps === null) {
    warnings.push("Không đọc được tốc độ khung hình của video — chưa kiểm tra được tiêu chí này");
  } else {
    if (limits.minFps !== null && spec.fps < limits.minFps - 0.5) {
      violations.push({
        rule: "FPS_MIN",
        actual: `${formatFps(spec.fps)} fps`,
        limit: `tối thiểu ${limits.minFps} fps`,
        userMessage: `Video chạy ${formatFps(spec.fps)} fps — ${label} yêu cầu tối thiểu ${limits.minFps} fps`,
      });
    }
    if (limits.maxFps !== null && spec.fps > limits.maxFps + 0.5) {
      violations.push({
        rule: "FPS_MAX",
        actual: `${formatFps(spec.fps)} fps`,
        limit: `tối đa ${limits.maxFps} fps`,
        userMessage: `Video chạy ${formatFps(spec.fps)} fps — ${label} chỉ nhận tối đa ${limits.maxFps} fps`,
      });
    }
  }

  if (violations.length > 0) return { ok: false, target, violations, warnings };
  return { ok: true, target, warnings };
}

/** One-line operator summary of a failed verdict, for logs and the UI badge. */
export function summarizeViolations(violations: readonly VideoSpecViolation[]): string {
  return violations.map((violation) => violation.userMessage).join("; ");
}

// --- helpers ----------------------------------------------------------------

/**
 * Returns a Vietnamese description of what makes the spec unusable, or null when
 * every field needed by the rules above is present and finite.
 */
function describeUnreadable(spec: VideoSpec): string | null {
  if (spec === null || typeof spec !== "object") return "không có dữ liệu thông số";

  const problems: string[] = [];
  if (typeof spec.container !== "string" || spec.container.trim().length === 0) {
    problems.push("thiếu định dạng file");
  }
  if (typeof spec.videoCodec !== "string" || spec.videoCodec.trim().length === 0) {
    problems.push("thiếu codec video");
  }
  if (!isPositiveFinite(spec.width) || !isPositiveFinite(spec.height)) {
    problems.push("thiếu kích thước khung hình");
  }
  if (!isPositiveFinite(spec.durationSec)) problems.push("thiếu thời lượng");
  if (!isPositiveFinite(spec.sizeBytes)) problems.push("thiếu dung lượng file");

  return problems.length > 0 ? problems.join(", ") : null;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** "mov,mp4,m4a,3gp,3g2,mj2" -> ["mov","mp4",...]. */
function tokenize(container: string): string[] {
  return container
    .toLowerCase()
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function formatSeconds(seconds: number): string {
  if (seconds >= SECONDS_PER_MINUTE) {
    const minutes = seconds / SECONDS_PER_MINUTE;
    const rounded = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1).replace(".", ",");
    return `${rounded} phút`;
  }
  return `${seconds.toFixed(1).replace(".", ",")} giây`;
}

function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GB) {
    return `${(bytes / BYTES_PER_GB).toFixed(1).replace(".", ",")} GB`;
  }
  return `${(bytes / 1_000_000).toFixed(1).replace(".", ",")} MB`;
}

function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(1).replace(".", ",");
}

/** 0.5625 -> "9:16", 1.7778 -> "16:9", anything else -> "1,23:1". */
function describeRatio(ratio: number): string {
  if (Math.abs(ratio - PORTRAIT_9_16) < ASPECT_TOLERANCE) return "9:16";
  if (Math.abs(ratio - LANDSCAPE_16_9) < ASPECT_TOLERANCE) return "16:9";
  if (Math.abs(ratio - 1) < ASPECT_TOLERANCE) return "1:1";
  if (Math.abs(ratio - 4 / 5) < ASPECT_TOLERANCE) return "4:5";
  return `${ratio.toFixed(2).replace(".", ",")}:1`;
}
