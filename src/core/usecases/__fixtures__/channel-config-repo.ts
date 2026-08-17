import { AppError } from "@/core/domain/errors";
import type { ChannelConfig, ChannelConfigRepo } from "@/core/ports/publisher";

/**
 * The WRITE half of ChannelConfigRepo for tests that only read it (publish,
 * retry, reschedule, reap, fan-out, channel groups). They must never write a
 * channel, so every stub throws instead of quietly answering "ok" — a usecase
 * that starts writing here is a change we want to see, not one that slips
 * through a permissive fake.
 *
 * Connect/import behaviour is tested against its own in-memory repo
 * (connect-facebook-channels.test.ts) and against a real Postgres
 * (adapters/db/channel-config-repo.write.integration.test.ts).
 */
export function channelWriteStubs(): Pick<
  ChannelConfigRepo,
  "upsertChannels" | "findUserAccessToken" | "setChannelStatus" | "removeChannel"
> {
  const refuse = (method: string): never => {
    throw new AppError("INTERNAL", {
      message: `${method} is not available in this read-only channel repo fake`,
      context: { method },
    });
  };

  return {
    upsertChannels: async () => refuse("upsertChannels"),
    findUserAccessToken: async (): Promise<string | null> => refuse("findUserAccessToken"),
    setChannelStatus: async (): Promise<ChannelConfig | null> => refuse("setChannelStatus"),
    removeChannel: async (): Promise<boolean> => refuse("removeChannel"),
  };
}
