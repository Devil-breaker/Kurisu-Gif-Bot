import type { Media } from '../types/index.js';

export type CatalogRemovalResult =
  | { status: 'missing' }
  | { status: 'database-error'; error: unknown }
  | {
      status: 'removed';
      archive: 'deleted' | 'already-missing' | 'not-linked' | 'channel-not-configured' | 'delete-failed';
      error?: unknown;
    };

/** Remove a GIF from the searchable library, then best-effort delete its archive post. */
export async function removeCatalogMedia(
  media: Media,
  channelId: number | undefined,
  dependencies: {
    deleteMedia: (mediaId: number) => Promise<boolean>;
    deleteChannelMessage: (channelId: number, messageId: number) => Promise<unknown>;
  },
): Promise<CatalogRemovalResult> {
  try {
    if (!(await dependencies.deleteMedia(media.id))) return { status: 'missing' };
  } catch (error) {
    return { status: 'database-error', error };
  }

  if (media.channel_msg_id === null) return { status: 'removed', archive: 'not-linked' };
  if (channelId === undefined) return { status: 'removed', archive: 'channel-not-configured' };

  try {
    await dependencies.deleteChannelMessage(channelId, media.channel_msg_id);
    return { status: 'removed', archive: 'deleted' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\bmessage to delete not found\b/i.test(message)) {
      return { status: 'removed', archive: 'already-missing' };
    }
    return { status: 'removed', archive: 'delete-failed', error };
  }
}
