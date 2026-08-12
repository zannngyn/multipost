import { z } from "zod";

/**
 * Contracts of the "Nhóm kênh" screen (E7.6 / E10.3).
 *
 * `ui/` may not import `core/` (docs/07 §2), so this mirrors
 * `core/domain/channel-group.ts` and `core/usecases/manage-channel-groups.ts`.
 * The limits below are the SAME numbers as the domain: the form refuses locally
 * what the server would refuse anyway, with the same Vietnamese sentence.
 */

export const MAX_CHANNEL_GROUP_NAME_LENGTH = 80;
export const MAX_CHANNELS_PER_GROUP = 50;

export const ChannelGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  channelIds: z.array(z.string().min(1)),
  channelCount: z.number(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ChannelGroup = z.infer<typeof ChannelGroupSchema>;

export const ChannelGroupListResponseSchema = z.object({
  tenantId: z.string().min(1),
  groups: z.array(ChannelGroupSchema),
});
export type ChannelGroupListResponse = z.infer<typeof ChannelGroupListResponseSchema>;

export const DeleteChannelGroupResponseSchema = z.object({
  groupId: z.string().min(1),
  deleted: z.literal(true),
});
export type DeleteChannelGroupResponse = z.infer<typeof DeleteChannelGroupResponseSchema>;

/**
 * Channel ids are typed in as free text (one per line / comma separated) until
 * E5.1 ships the real "connect a Page" flow. The server still refuses any id
 * the tenant does not own, so a typo is caught — this only saves a round trip
 * on the obvious mistakes.
 */
export const ChannelGroupFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nhóm kênh phải có tên.")
    .max(
      MAX_CHANNEL_GROUP_NAME_LENGTH,
      `Tên nhóm kênh tối đa ${MAX_CHANNEL_GROUP_NAME_LENGTH} ký tự.`,
    ),
  channelIdsText: z
    .string()
    .trim()
    .min(1, "Nhóm kênh phải có ít nhất một kênh.")
    .refine((value) => parseChannelIds(value).length > 0, {
      message: "Nhóm kênh phải có ít nhất một kênh.",
    })
    .refine((value) => parseChannelIds(value).length <= MAX_CHANNELS_PER_GROUP, {
      message: `Một nhóm kênh chỉ chứa tối đa ${MAX_CHANNELS_PER_GROUP} kênh.`,
    }),
});
export type ChannelGroupFormValues = z.infer<typeof ChannelGroupFormSchema>;

/** Splits on newlines and commas, trims, drops blanks and duplicates. */
export function parseChannelIds(raw: string): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const channelId = part.trim();
    if (channelId.length === 0 || seen.has(channelId)) continue;
    seen.add(channelId);
    result.push(channelId);
  }
  return result;
}

/** Inverse of `parseChannelIds`, for prefilling the edit form. */
export function formatChannelIds(channelIds: readonly string[]): string {
  return channelIds.join("\n");
}
