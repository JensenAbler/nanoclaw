/**
 * Shared media utilities for saving images and audio from channels (WhatsApp, Discord)
 * to the IPC media directory where agents can read them.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/** Map common MIME types to file extensions */
function mimeToExt(mimetype: string): string {
  const sub = mimetype.split('/')[1]?.split(';')[0]?.toLowerCase() || 'jpg';
  switch (sub) {
    case 'jpeg':
      return 'jpg';
    case 'png':
      return 'png';
    case 'webp':
      return 'webp';
    case 'gif':
      return 'gif';
    case 'heic':
      return 'heic';
    case 'heif':
      return 'heif';
    // Audio types
    case 'ogg':
      return 'ogg';
    case 'mp4':
      return 'm4a';
    case 'mpeg':
      return 'mp3';
    case 'wav':
      return 'wav';
    case 'webm':
      return 'webm';
    default:
      return 'jpg';
  }
}

/**
 * Save an image buffer to the group's IPC media directory.
 * Returns the absolute host path (e.g., /home/ubuntu/nanoclaw/data/ipc/main/media/msgid.jpg)
 * or null if saving fails.
 */
export function saveImageToIpc(
  buffer: Buffer,
  groupFolder: string,
  msgId: string,
  mimetype: string,
): string | null {
  try {
    if (!buffer || buffer.length === 0) {
      logger.warn('saveImageToIpc: empty buffer');
      return null;
    }

    const ext = mimeToExt(mimetype);
    // Sanitize msgId to prevent path traversal
    const safeMsgId = msgId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeMsgId}.${ext}`;

    const mediaDir = path.join(DATA_DIR, 'ipc', groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const hostPath = path.join(mediaDir, filename);
    fs.writeFileSync(hostPath, buffer);

    logger.info(
      { groupFolder, filename, size: buffer.length },
      'Image saved to IPC media directory',
    );

    return hostPath;
  } catch (err) {
    logger.error({ err, groupFolder, msgId }, 'Failed to save image to IPC');
    return null;
  }
}

/**
 * Save an audio buffer to the group's IPC media directory.
 * Returns the absolute host path or null if saving fails.
 */
export function saveAudioToIpc(
  buffer: Buffer,
  groupFolder: string,
  msgId: string,
  mimetype: string,
): string | null {
  try {
    if (!buffer || buffer.length === 0) {
      logger.warn('saveAudioToIpc: empty buffer');
      return null;
    }

    const ext = mimeToExt(mimetype);
    const safeMsgId = msgId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeMsgId}.${ext}`;

    const mediaDir = path.join(DATA_DIR, 'ipc', groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const hostPath = path.join(mediaDir, filename);
    fs.writeFileSync(hostPath, buffer);

    logger.info(
      { groupFolder, filename, size: buffer.length },
      'Audio saved to IPC media directory',
    );

    return hostPath;
  } catch (err) {
    logger.error({ err, groupFolder, msgId }, 'Failed to save audio to IPC');
    return null;
  }
}

/**
 * Format message content for an image message.
 * Returns a string like "[Image: /path/to/media/xxx.jpg]\nCaption text"
 */
export function formatImageContent(
  containerPath: string,
  caption?: string,
): string {
  if (caption) {
    return `[Image: ${containerPath}]\n${caption}`;
  }
  return `[Image: ${containerPath}]`;
}
