import { describe, expect, it, vi } from 'vitest';
import { removeCatalogMedia } from '../../src/services/media-removal.js';
import type { Media } from '../../src/types/index.js';

const media: Media = {
  id: 7,
  file_id: 'file-id',
  file_unique_id: 'unique-id',
  phash: null,
  usage_count: 2,
  is_lewd: 0,
  channel_msg_id: 42,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('removeCatalogMedia', () => {
  it('removes the library record and linked archive post', async () => {
    const deleteMedia = vi.fn(async () => true);
    const deleteChannelMessage = vi.fn(async () => true);

    const result = await removeCatalogMedia(media, -100123, { deleteMedia, deleteChannelMessage });

    expect(result).toEqual({ status: 'removed', archive: 'deleted' });
    expect(deleteMedia).toHaveBeenCalledWith(7);
    expect(deleteChannelMessage).toHaveBeenCalledWith(-100123, 42);
  });

  it('does not delete an archive post if the database removal fails', async () => {
    const deleteMedia = vi.fn(async () => { throw new Error('database unavailable'); });
    const deleteChannelMessage = vi.fn(async () => true);

    const result = await removeCatalogMedia(media, -100123, { deleteMedia, deleteChannelMessage });

    expect(result.status).toBe('database-error');
    expect(deleteChannelMessage).not.toHaveBeenCalled();
  });

  it('reports an archive deletion failure after removing the library record', async () => {
    const deleteMedia = vi.fn(async () => true);
    const deleteChannelMessage = vi.fn(async () => { throw new Error('message too old'); });

    const result = await removeCatalogMedia(media, -100123, { deleteMedia, deleteChannelMessage });

    expect(result).toMatchObject({ status: 'removed', archive: 'delete-failed' });
  });

  it('treats an archive post deleted manually as already removed', async () => {
    const deleteMedia = vi.fn(async () => true);
    const deleteChannelMessage = vi.fn(async () => { throw new Error('Bad Request: message to delete not found'); });

    const result = await removeCatalogMedia(media, -100123, { deleteMedia, deleteChannelMessage });

    expect(result).toEqual({ status: 'removed', archive: 'already-missing' });
  });

  it('handles a missing archive link without calling Telegram', async () => {
    const deleteMedia = vi.fn(async () => true);
    const deleteChannelMessage = vi.fn(async () => true);

    const result = await removeCatalogMedia({ ...media, channel_msg_id: null }, -100123, {
      deleteMedia,
      deleteChannelMessage,
    });

    expect(result).toEqual({ status: 'removed', archive: 'not-linked' });
    expect(deleteChannelMessage).not.toHaveBeenCalled();
  });
});
