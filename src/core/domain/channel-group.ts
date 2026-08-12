/**
 * ChannelGroup (E7.6) — a saved set of channels an operator picks in one click
 * instead of ticking the same five Pages every time (brief §5: "nhóm kênh đặt
 * sẵn"). Pure TypeScript, no I/O (docs/07 §2).
 *
 * A group is a SHORTCUT, never an authority: fan-out still creates one post_job
 * per channel and the publish rules (stock recheck, spacing, anti-duplicate) are
 * unchanged. Membership is therefore validated against the tenant's real
 * channels every time the group is written — a group holding a channel that no
 * longer exists would silently drop a post at fan-out time.
 */

import { AppError } from "./errors";

export const MAX_CHANNEL_GROUP_NAME_LENGTH = 80;
/** Sanity ceiling: a "group" of 50 Pages is a mistake, not a workflow. */
export const MAX_CHANNELS_PER_GROUP = 50;

export interface ChannelGroup {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  /** Channel ids of tenant_integration, order preserved as the operator set it. */
  readonly channelIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NormalisedChannelGroupFields {
  readonly name: string;
  readonly channelIds: readonly string[];
}

/**
 * Normalises + validates the two fields a caller controls. Throws INVALID_INPUT
 * (never returns a "best effort" group): an empty group would produce a post
 * batch with zero channels, i.e. a click that does nothing and says nothing.
 */
export function normaliseChannelGroupFields(input: {
  readonly name?: unknown;
  readonly channelIds?: unknown;
}): NormalisedChannelGroupFields {
  // --- Edge cases first -----------------------------------------------------
  const name = typeof input?.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (name.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "A channel group needs a name",
      userMessage: "Nhóm kênh phải có tên.",
      context: { field: "name", reason: "EMPTY" },
    });
  }
  if (name.length > MAX_CHANNEL_GROUP_NAME_LENGTH) {
    throw new AppError("INVALID_INPUT", {
      message: `Channel group name exceeds ${MAX_CHANNEL_GROUP_NAME_LENGTH} characters`,
      userMessage: `Tên nhóm kênh tối đa ${MAX_CHANNEL_GROUP_NAME_LENGTH} ký tự.`,
      context: { field: "name", length: name.length, max: MAX_CHANNEL_GROUP_NAME_LENGTH },
    });
  }

  const raw = Array.isArray(input?.channelIds) ? input.channelIds : [];
  const channelIds: string[] = [];
  for (const value of raw) {
    const channelId = typeof value === "string" ? value.trim() : "";
    if (channelId.length === 0) continue;
    if (!channelIds.includes(channelId)) channelIds.push(channelId);
  }
  if (channelIds.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "A channel group needs at least one channel",
      userMessage: "Nhóm kênh phải có ít nhất một kênh.",
      context: { field: "channelIds", reason: "EMPTY", name },
    });
  }
  if (channelIds.length > MAX_CHANNELS_PER_GROUP) {
    throw new AppError("INVALID_INPUT", {
      message: `A channel group holds at most ${MAX_CHANNELS_PER_GROUP} channels`,
      userMessage: `Một nhóm kênh chỉ chứa tối đa ${MAX_CHANNELS_PER_GROUP} kênh.`,
      context: { field: "channelIds", count: channelIds.length, max: MAX_CHANNELS_PER_GROUP },
    });
  }

  return { name, channelIds };
}

/** Channel ids of the group that the tenant does not (or no longer) own. */
export function unknownChannelIds(
  channelIds: readonly string[],
  knownChannelIds: readonly string[],
): string[] {
  const known = new Set(knownChannelIds);
  return channelIds.filter((channelId) => !known.has(channelId));
}
