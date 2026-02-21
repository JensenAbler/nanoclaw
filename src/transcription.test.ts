import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs to control config loading
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
  };
});

import fs from 'fs';
import { transcribeAudio, formatVoiceContent, loadTranscriptionConfig } from './transcription.js';

const mockReadFileSync = vi.mocked(fs.readFileSync);

describe('transcription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadTranscriptionConfig', () => {
    it('loads config from file', () => {
      mockReadFileSync.mockReturnValueOnce(JSON.stringify({
        provider: 'openai',
        openai: { apiKey: 'sk-test', model: 'whisper-1' },
        enabled: true,
        fallbackMessage: '[Voice Message - transcription unavailable]',
      }));

      const config = loadTranscriptionConfig();
      expect(config.enabled).toBe(true);
      expect(config.provider).toBe('openai');
      expect(config.openai?.apiKey).toBe('sk-test');
    });

    it('returns disabled config when file not found', () => {
      mockReadFileSync.mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });

      const config = loadTranscriptionConfig();
      expect(config.enabled).toBe(false);
      expect(config.fallbackMessage).toBe('[Voice Message - transcription unavailable]');
    });
  });

  describe('formatVoiceContent', () => {
    it('wraps transcript in [Voice: ...] format', () => {
      expect(formatVoiceContent('Hello world')).toBe('[Voice: Hello world]');
    });

    it('handles empty transcript', () => {
      expect(formatVoiceContent('')).toBe('[Voice: ]');
    });

    it('handles multi-line transcript', () => {
      expect(formatVoiceContent('Line 1\nLine 2')).toBe('[Voice: Line 1\nLine 2]');
    });
  });

  describe('transcribeAudio', () => {
    it('returns fallback when transcription is disabled', async () => {
      mockReadFileSync.mockReturnValueOnce(JSON.stringify({
        provider: 'openai',
        enabled: false,
        fallbackMessage: '[Voice Message - transcription unavailable]',
      }));

      const result = await transcribeAudio(Buffer.from('audio'), 'audio/ogg');
      expect(result).toBe('[Voice Message - transcription unavailable]');
    });

    it('returns fallback for empty buffer', async () => {
      mockReadFileSync.mockReturnValueOnce(JSON.stringify({
        provider: 'openai',
        openai: { apiKey: 'sk-test', model: 'whisper-1' },
        enabled: true,
        fallbackMessage: '[Voice Message - transcription unavailable]',
      }));

      const result = await transcribeAudio(Buffer.alloc(0), 'audio/ogg');
      expect(result).toBe('[Voice Message - transcription unavailable]');
    });

    it('returns fallback for unknown provider', async () => {
      mockReadFileSync.mockReturnValueOnce(JSON.stringify({
        provider: 'unknown-provider',
        enabled: true,
        fallbackMessage: '[Voice Message - transcription unavailable]',
      }));

      const result = await transcribeAudio(Buffer.from('audio'), 'audio/ogg');
      expect(result).toBe('[Voice Message - transcription unavailable]');
    });

    it('returns fallback when config file is missing', async () => {
      mockReadFileSync.mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });

      const result = await transcribeAudio(Buffer.from('audio'), 'audio/ogg');
      expect(result).toBe('[Voice Message - transcription unavailable]');
    });
  });
});
