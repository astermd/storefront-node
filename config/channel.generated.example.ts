/**
 * The shape of `config/channel.generated.ts`, which `theme:sync --apply` writes from live channel
 * data and which is never committed. Copy this file to `config/channel.generated.ts` on a fresh
 * clone: the app builds and runs with no payment processor configured.
 */
export interface GeneratedChannelConfig {
  channel: { id: string | null; name: string | null };
  payment_processor: { provider_category: string | null; name: string | null; config: Record<string, unknown> };
}

export const channelGenerated: GeneratedChannelConfig = {
  channel: { id: null, name: null },
  payment_processor: { provider_category: null, name: null, config: {} },
};
