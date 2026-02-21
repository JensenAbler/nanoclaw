/**
 * Voice message transcription using OpenAI Whisper API.
 *
 * Used by both WhatsApp and Discord channel adapters.
 * Accepts a raw audio buffer and returns transcribed text.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Transcription configuration stored in .transcription.config.json */
export interface TranscriptionConfig {
  provider: string;
  openai?: {
    apiKey: string;
    model: string;
  };
  enabled: boolean;
  fallbackMessage: string;
}

/** Load transcription config from project root */
export function loadTranscriptionConfig(): TranscriptionConfig {
  const configPath = path.join(__dirname, '../.transcription.config.json');
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } catch {
    logger.warn('Transcription config not found or invalid — transcription disabled');
    return {
      provider: 'openai',
      enabled: false,
      fallbackMessage: '[Voice Message - transcription unavailable]',
    };
  }
}

/**
 * Transcribe an audio buffer using the configured provider.
 *
 * @param audioBuffer - Raw audio data (typically .ogg Opus from WhatsApp/Discord)
 * @param mimetype - MIME type of the audio (e.g., 'audio/ogg; codecs=opus')
 * @returns Transcribed text, fallback message, or null on failure
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimetype = 'audio/ogg',
): Promise<string> {
  const config = loadTranscriptionConfig();

  if (!config.enabled) {
    logger.debug('Transcription disabled in config');
    return config.fallbackMessage;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    logger.warn('transcribeAudio: empty buffer');
    return config.fallbackMessage;
  }

  logger.info({ size: audioBuffer.length, mimetype }, 'Transcribing audio');

  try {
    let transcript: string | null = null;

    switch (config.provider) {
      case 'openai':
        transcript = await transcribeWithOpenAI(audioBuffer, mimetype, config);
        break;
      default:
        logger.error({ provider: config.provider }, 'Unknown transcription provider');
        return config.fallbackMessage;
    }

    if (!transcript) {
      return config.fallbackMessage;
    }

    const trimmed = transcript.trim();
    logger.info({ length: trimmed.length }, 'Transcription complete');
    return trimmed;
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

/**
 * Transcribe audio using OpenAI Whisper API.
 */
async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  mimetype: string,
  config: TranscriptionConfig,
): Promise<string | null> {
  if (!config.openai?.apiKey || config.openai.apiKey === '') {
    logger.warn('OpenAI API key not configured for transcription');
    return null;
  }

  try {
    // Dynamic import to avoid hard dependency when transcription is disabled
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({
      apiKey: config.openai.apiKey,
    });

    // Determine filename extension and normalized type from mimetype
    // Whisper uses the filename extension to detect format, so they must match.
    let ext = 'ogg';
    let normalizedType = 'audio/ogg';
    const base = mimetype.split(';')[0].trim().toLowerCase();
    if (base.includes('mp4') || base.includes('m4a') || base === 'audio/mp4') {
      ext = 'm4a';
      normalizedType = 'audio/mp4';
    } else if (base.includes('mpeg') || base.includes('mp3')) {
      ext = 'mp3';
      normalizedType = 'audio/mpeg';
    } else if (base.includes('webm')) {
      ext = 'webm';
      normalizedType = 'audio/webm';
    } else if (base.includes('wav')) {
      ext = 'wav';
      normalizedType = 'audio/wav';
    } else if (base.includes('ogg')) {
      ext = 'ogg';
      normalizedType = 'audio/ogg';
    }
    const file = await toFile(audioBuffer, `voice.${ext}`, {
      type: normalizedType,
    });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: config.openai.model || 'whisper-1',
      response_format: 'text',
    });

    // When response_format is 'text', the SDK returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}

/**
 * Format transcribed voice message content for the agent.
 * Returns "[Voice: transcribed text here]"
 */
export function formatVoiceContent(transcript: string): string {
  return `[Voice: ${transcript}]`;
}
