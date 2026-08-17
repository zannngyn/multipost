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
 * Channels are TICKED, never typed (E5.1). The form only offers ids the tenant
 * actually owns, which is why the free-text parser this schema used to carry is
 * gone: an id typed by hand was rejected by the server every single time, and
 * there is no longer any screen that produces one.
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
  channelIds: z
    .array(z.string().min(1))
    // Deduplicated BEFORE the limits are checked: a repeated id is one channel,
    // so it must neither count towards the maximum nor turn into a second
    // post_job for the same Page. The ticking UI cannot produce a duplicate
    // today, but the array shape allows one and the server would fan out twice.
    .transform(uniqueChannelIds)
    .refine((ids) => ids.length >= 1, { message: "Nhóm kênh phải có ít nhất một kênh." })
    .refine((ids) => ids.length <= MAX_CHANNELS_PER_GROUP, {
      message: `Một nhóm kênh chỉ chứa tối đa ${MAX_CHANNELS_PER_GROUP} kênh.`,
    }),
});
export type ChannelGroupFormValues = z.infer<typeof ChannelGroupFormSchema>;

/** Keeps the first occurrence, so the order the operator ticked in survives. */
export function uniqueChannelIds(channelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const channelId of channelIds) {
    if (seen.has(channelId)) continue;
    seen.add(channelId);
    result.push(channelId);
  }
  return result;
}
