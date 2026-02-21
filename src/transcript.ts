/**
 * Transcript archiving utilities.
 *
 * Parses Claude SDK JSONL transcripts and converts them to searchable
 * markdown files stored in `groups/{folder}/conversations/`.
 *
 * The markdown format is designed to be easily searchable with the
 * built-in Glob, Grep, and Read tools that agents use.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Parse a Claude SDK JSONL transcript into user/assistant messages.
 *
 * Each line in the JSONL is a JSON object with a `type` field.
 * We only extract `user` and `assistant` messages, ignoring
 * system events, queue operations, tool results, etc.
 */
export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      if (entry.type === 'user' && entry.message?.content) {
        // User content can be a plain string or an array of content blocks
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        // Assistant content is always an array; filter to text blocks only
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  return messages;
}

/**
 * Format parsed messages as a clean markdown document.
 *
 * Output format (optimized for Grep/Read searching):
 *
 * ```markdown
 * # {title}
 *
 * Archived: Feb 16, 3:52 AM
 *
 * ---
 *
 * **User**: message text
 *
 * **nano**: response text
 * ```
 */
export function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  assistantName: string,
  title?: string | null,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName;
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Sanitize a string for use as a filename.
 * Lowercase, alphanumeric + hyphens only, max 50 chars.
 */
export function sanitizeFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Generate a fallback filename based on current time.
 */
export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * Extract a topic hint from the first substantive user message for use as filename/title.
 * Tries each user message in order until one has real content.
 * Strips XML/markdown noise from WhatsApp message wrappers.
 */
function extractTopic(messages: ParsedMessage[]): string | null {
  const userMessages = messages.filter((m) => m.role === 'user');

  for (const msg of userMessages) {
    // Strip XML tags (WhatsApp messages come wrapped in <messages><message>...)
    let text = msg.content
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Take first line or first 80 chars
    const firstLine = text.split('\n')[0];
    text = firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine;

    // Must have at least a few real characters
    if (text.replace(/[^a-zA-Z0-9]/g, '').length < 3) continue;

    return text;
  }

  return null;
}

/**
 * Archive a session's transcript to the conversations/ directory.
 *
 * Reads the JSONL transcript, parses it into messages, and writes
 * a searchable markdown file to `groups/{groupFolder}/conversations/`.
 *
 * @returns true if archived successfully, false on failure.
 *          Failures are logged but never thrown — archiving should
 *          not block the /new command.
 */
export function archiveSession(
  sessionKey: string,
  sessionId: string,
  assistantName: string,
  groupFolder?: string,
): boolean {
  // Find the JSONL transcript — session dirs are named by sanitized sessionKey (chatJid)
  const sessionDirName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const transcriptPath = path.join(
    DATA_DIR,
    'sessions',
    sessionDirName,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );

  if (!fs.existsSync(transcriptPath)) {
    logger.warn(
      { groupFolder, sessionId, transcriptPath },
      'Transcript not found for archiving',
    );
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);

    if (messages.length === 0) {
      logger.info({ groupFolder, sessionId }, 'No messages to archive');
      return false;
    }

    // Generate title and filename from first user message
    const topic = extractTopic(messages);
    const name = topic ? sanitizeFilename(topic) : generateFallbackName();
    const title = topic || 'Conversation';

    // Write to conversations/ directory under the group folder
    // Use groupFolder if provided, otherwise fall back to sessionKey (for backwards compat)
    const archiveFolder = groupFolder || sessionKey;
    const conversationsDir = path.join(GROUPS_DIR, archiveFolder, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    // Avoid overwriting if a file with same name exists (multiple /new in one day)
    let finalPath = filePath;
    if (fs.existsSync(finalPath)) {
      const time = new Date();
      const suffix = `${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
      finalPath = path.join(conversationsDir, `${date}-${name}-${suffix}.md`);
    }

    const markdown = formatTranscriptMarkdown(messages, assistantName, title);
    fs.writeFileSync(finalPath, markdown);

    logger.info(
      { groupFolder, sessionId, path: finalPath, messageCount: messages.length },
      'Conversation archived',
    );
    return true;
  } catch (err) {
    logger.error(
      { groupFolder, sessionId, err },
      'Failed to archive conversation',
    );
    return false;
  }
}
