/**
 * Agent Runner for NanoClaw (de-containerized)
 *
 * Runs the Claude Agent SDK directly in-process, replacing both:
 *   - container-runner.ts (Docker spawning + IPC output parsing)
 *   - container/agent-runner/src/index.ts (SDK integration inside container)
 *
 * Key differences from the containerized approach:
 *   - No Docker, no stdout markers, no file-based IPC for input/output
 *   - MCP tools (send_message, schedule_task, etc.) are direct function calls
 *   - Follow-up messages are pushed directly into the MessageStream
 *   - Session state lives in DATA_DIR/sessions/{group}/.claude/
 */

import fs from 'fs';
import path from 'path';

import {
  query,
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  parseTranscript,
  formatTranscriptMarkdown,
  sanitizeFilename,
  generateFallbackName,
} from './transcript.js';
import { RegisteredGroup } from './types.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db.js';
import { validateAdditionalMounts } from './mount-security.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

interface SessionsIndex {
  entries: Array<{
    sessionId: string;
    fullPath: string;
    summary: string;
    firstPrompt: string;
  }>;
}

// ---------------------------------------------------------------------------
// MessageStream — push-based async iterable for multi-turn SDK queries
// ---------------------------------------------------------------------------

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  get isDone(): boolean {
    return this.done;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Agent handle — returned to callers for follow-up message piping
// ---------------------------------------------------------------------------

export interface AgentHandle {
  /** Push a follow-up message into the running query */
  pushMessage: (text: string) => void;
  /** Signal the agent to wind down after the current query finishes */
  close: () => void;
  /** The MessageStream (for GroupQueue to hold) */
  stream: MessageStream;
  /** Promise that resolves when the agent loop finishes */
  done: Promise<AgentOutput>;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_REFRESH_TOKEN',
];

function readSecrets(): Record<string, string> {
  return readEnvFile(SECRET_ENV_VARS);
}

// ---------------------------------------------------------------------------
// OAuth credential sync
//
// The SDK stores credentials in ~/.claude/.credentials.json. Each agent
// overrides HOME, so each has its own copy. When any agent refreshes a
// token, the new credentials must propagate to all other agents.
//
// Strategy: use REAL_HOME/.claude/.credentials.json as the canonical source.
// Before each query, sync the freshest token (highest expiresAt) from
// either global or the agent's copy. After each query, sync the agent's
// (possibly refreshed) copy back to global if it's newer.
// ---------------------------------------------------------------------------

/** The real home directory, captured before any HOME overrides. */
const REAL_HOME = process.env.HOME || '/home/ubuntu';

function getGlobalCredsPath(): string {
  return path.join(REAL_HOME, '.claude', '.credentials.json');
}

function getSessionCredsPath(chatJid: string): string {
  const sessionDirName = chatJid.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, 'sessions', sessionDirName, '.claude', '.credentials.json');
}

interface OAuthCreds {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

function readCreds(filePath: string): OAuthCreds | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCreds(filePath: string, creds: OAuthCreds): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(creds), { mode: 0o600 });
}

/**
 * Before a query: copy the freshest credentials to the agent's session dir.
 * Compares global vs agent's copy and uses whichever has a later expiresAt.
 */
function syncCredentialsToGroup(groupClaudeDir: string): void {
  try {
    const globalPath = getGlobalCredsPath();
    const groupPath = path.join(groupClaudeDir, '.credentials.json');
    const globalCreds = readCreds(globalPath);
    const groupCreds = readCreds(groupPath);

    if (!globalCreds && !groupCreds) return;

    const globalExpiry = globalCreds?.claudeAiOauth?.expiresAt ?? 0;
    const groupExpiry = groupCreds?.claudeAiOauth?.expiresAt ?? 0;

    if (globalExpiry >= groupExpiry && globalCreds) {
      // Global is fresher (or equal) — copy to agent
      writeCreds(groupPath, globalCreds);
    } else if (groupCreds) {
      // Agent has a fresher token — copy back to global
      writeCreds(globalPath, groupCreds);
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to sync credentials to group session',
    );
  }
}

/**
 * After a query: if the agent refreshed the token, propagate it back
 * to global so other agents pick it up on their next startup.
 */
function syncCredentialsFromGroup(chatJid: string): void {
  try {
    const globalPath = getGlobalCredsPath();
    const groupPath = getSessionCredsPath(chatJid);
    const globalCreds = readCreds(globalPath);
    const groupCreds = readCreds(groupPath);

    if (!groupCreds?.claudeAiOauth?.expiresAt) return;

    const globalExpiry = globalCreds?.claudeAiOauth?.expiresAt ?? 0;
    const groupExpiry = groupCreds.claudeAiOauth.expiresAt;

    if (groupExpiry > globalExpiry) {
      writeCreds(globalPath, groupCreds);
      logger.debug(
        { chatJid },
        'Agent refreshed OAuth token, propagated to global',
      );
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to sync credentials from group session',
    );
  }
}

// ---------------------------------------------------------------------------
// Per-group session & workspace setup
// ---------------------------------------------------------------------------

function ensureGroupWorkspace(group: RegisteredGroup, isMain: boolean, chatJid: string): void {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Per-conversation Claude sessions directory (keyed by sanitized chatJid)
  // This must match the homeDirOverride used in resolveWorkspacePaths
  const sessionDirName = chatJid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    sessionDirName,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Settings file for Claude SDK
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync OAuth credentials so the SDK can auto-refresh tokens.
  // The SDK reads ~/.claude/.credentials.json for the full OAuth flow
  // (access token + refresh token). Without this, expired tokens can't
  // be refreshed and agents fail with SessionEnd.
  syncCredentialsToGroup(groupSessionsDir);

  // Sync skills from container/skills/ (or skills/ once cleanup is done)
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsSrcAlt = path.join(process.cwd(), 'skills');
  const actualSkillsSrc = fs.existsSync(skillsSrc)
    ? skillsSrc
    : fs.existsSync(skillsSrcAlt)
      ? skillsSrcAlt
      : null;

  if (actualSkillsSrc) {
    const skillsDst = path.join(groupSessionsDir, 'skills');
    for (const skillDir of fs.readdirSync(actualSkillsSrc)) {
      const srcDir = path.join(actualSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
}

/**
 * Resolve the working directory and additional directories for the SDK.
 * Replaces Docker volume mounts with direct filesystem paths.
 */
function resolveWorkspacePaths(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
): { cwd: string; additionalDirectories: string[]; homeDirOverride: string } {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  const additionalDirectories: string[] = [];

  // Global CLAUDE.md for non-main groups
  if (!isMain) {
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      additionalDirectories.push(globalDir);
    }
  }

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      additionalDirectories.push(mount.hostPath);
    }
  }

  // Override HOME so the SDK uses a per-conversation .claude/ directory.
  // Using chatJid ensures each DM user gets their own session, while
  // sharing the same group folder (CLAUDE.md, tools, etc.).
  // Sanitize chatJid for use as directory name (replace @ and other special chars)
  const sessionDirName = chatJid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const homeDirOverride = path.join(DATA_DIR, 'sessions', sessionDirName);

  return { cwd: groupDir, additionalDirectories, homeDirOverride };
}

// ---------------------------------------------------------------------------
// Hooks — PreCompact (archive transcript) and PreToolUse (sanitize bash)
// ---------------------------------------------------------------------------

function createPreCompactHook(groupFolder: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      logger.debug({ groupFolder }, 'No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        return {};
      }

      // Try to get session summary from sessions-index.json
      let summary: string | null = null;
      const projectDir = path.dirname(transcriptPath);
      const indexPath = path.join(projectDir, 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index: SessionsIndex = JSON.parse(
            fs.readFileSync(indexPath, 'utf-8'),
          );
          const entry = index.entries.find((e) => e.sessionId === sessionId);
          if (entry?.summary) {
            summary = entry.summary;
          }
        } catch {
          // ignore
        }
      }

      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, ASSISTANT_NAME, summary);
      fs.writeFileSync(filePath, markdown);

      logger.debug({ groupFolder, filePath }, 'Archived conversation via PreCompact');
    } catch (err) {
      logger.warn(
        { groupFolder, err },
        'Failed to archive transcript in PreCompact hook',
      );
    }

    return {};
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

// ---------------------------------------------------------------------------
// MCP server for tools (send_message, schedule_task, etc.)
//
// Instead of writing IPC files, these call host functions directly.
// The MCP server is spawned as a child process per the SDK's mcpServers
// option. We provide a small inline script that the SDK launches.
// ---------------------------------------------------------------------------

/**
 * Build the MCP tools config.
 *
 * Since the SDK expects mcpServers to be child processes, and we want
 * direct function calls, we use the same file-based IPC MCP server
 * for now but point it at a local directory. The IPC watcher on the
 * host side already processes these.
 *
 * TODO: In a future iteration, implement a custom MCP transport that
 * calls functions directly without the filesystem round-trip.
 */
function buildMcpConfig(
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  // Point MCP server at the compiled mcp-server.js in the host dist/
  // The IPC watcher already processes files from data/ipc/{group}/
  const mcpServerPath = path.join(
    process.cwd(),
    'dist',
    'mcp-server.js',
  );

  // Create IPC directories that the MCP server writes to
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'media'), { recursive: true });

  return {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: chatJid,
        NANOCLAW_GROUP_FOLDER: groupFolder,
        NANOCLAW_IS_MAIN: isMain ? '1' : '0',
        // Override the IPC directory to point at host paths
        NANOCLAW_IPC_DIR: groupIpcDir,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tasks & Groups snapshots (for the MCP list_tasks tool to read)
// ---------------------------------------------------------------------------

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Core: runAgentQuery — single SDK query with MessageStream
// ---------------------------------------------------------------------------

async function runAgentQuery(
  stream: MessageStream,
  prompt: string,
  sessionId: string | undefined,
  input: AgentInput,
  sdkEnv: Record<string, string | undefined>,
  mcpConfig: Record<string, { command: string; args: string[]; env: Record<string, string> }>,
  workspace: { cwd: string; additionalDirectories: string[]; homeDirOverride: string },
  resumeAt?: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  stream.push(prompt);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context
  const globalClaudeMdPath = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Override HOME for this query so sessions are per-group
  const savedHome = process.env.HOME;
  process.env.HOME = workspace.homeDirOverride;
  
  // Update sdkEnv with the correct HOME
  sdkEnv.HOME = workspace.homeDirOverride;

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        model: 'opus',
        cwd: workspace.cwd,
        additionalDirectories:
          workspace.additionalDirectories.length > 0
            ? workspace.additionalDirectories
            : undefined,
        systemPrompt: globalClaudeMd
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: globalClaudeMd,
            }
          : undefined,
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Task',
          'TaskOutput',
          'TaskStop',
          'TeamCreate',
          'TeamDelete',
          'SendMessage',
          'TodoWrite',
          'ToolSearch',
          'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*',
        ],
        env: sdkEnv,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        executable: '/usr/bin/node' as 'node',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: mcpConfig,
        hooks: {
          PreCompact: [
            { hooks: [createPreCompactHook(input.groupFolder)] },
          ],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
          ],
        },
      },
    })) {
      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      logger.trace(
        { groupFolder: input.groupFolder, messageCount, msgType },
        'SDK message',
      );

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        logger.debug(
          { groupFolder: input.groupFolder, sessionId: newSessionId },
          'Session initialized',
        );
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message
            ? (message as { result?: string }).result
            : null;
        logger.debug(
          {
            groupFolder: input.groupFolder,
            resultCount,
            subtype: message.subtype,
            textLength: textResult?.length,
          },
          'Query result',
        );

        if (onOutput) {
          await onOutput({
            status: 'success',
            result: textResult || null,
            newSessionId,
          });
        }
      }
    }
  } finally {
    // Restore HOME
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
  }

  const closedDuringQuery = stream.isDone;

  // After query: sync any refreshed credentials back to global
  syncCredentialsFromGroup(input.chatJid);

  logger.debug(
    {
      groupFolder: input.groupFolder,
      messageCount,
      resultCount,
      closedDuringQuery,
    },
    'Query completed',
  );

  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

// ---------------------------------------------------------------------------
// Public API: runAgent — manages the full query loop
// ---------------------------------------------------------------------------

/**
 * Run an agent for a group. Returns an AgentHandle that allows pushing
 * follow-up messages and closing the session.
 *
 * The query loop:
 *   1. Run query with initial prompt
 *   2. When query ends, check if stream is closed → exit
 *   3. Otherwise wait for next message push → run new query
 *   4. Repeat until stream.end() is called
 */
export function runAgent(
  group: RegisteredGroup,
  input: AgentInput,
  onOutput?: (output: AgentOutput) => Promise<void>,
): AgentHandle {
  const stream = new MessageStream();

  const donePromise = (async (): Promise<AgentOutput> => {
    // Setup workspace
    ensureGroupWorkspace(group, input.isMain, input.chatJid);
    const workspace = resolveWorkspacePaths(group, input.isMain, input.chatJid);

    // Build SDK environment with secrets
    const secrets = readSecrets();
    const sdkEnv: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(secrets)) {
      sdkEnv[key] = value;
    }
    // Set ASSISTANT_NAME so the PreCompact hook can use it
    sdkEnv.ASSISTANT_NAME = ASSISTANT_NAME;

    // Build MCP config
    const mcpConfig = buildMcpConfig(
      input.groupFolder,
      input.chatJid,
      input.isMain,
    );

    // Build initial prompt
    let prompt = input.prompt;
    if (input.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }

    let sessionId = input.sessionId;
    let resumeAt: string | undefined;
    let lastError: string | undefined;

    try {
      // Query loop: run query → wait for follow-up → run again
      while (true) {
        logger.debug(
          {
            groupFolder: input.groupFolder,
            sessionId: sessionId || 'new',
            resumeAt: resumeAt || 'latest',
          },
          'Starting query',
        );

        const queryResult = await runAgentQuery(
          stream,
          prompt,
          sessionId,
          input,
          sdkEnv,
          mcpConfig,
          workspace,
          resumeAt,
          onOutput,
        );

        if (queryResult.newSessionId) {
          sessionId = queryResult.newSessionId;
        }
        if (queryResult.lastAssistantUuid) {
          resumeAt = queryResult.lastAssistantUuid;
        }

        // If close was triggered during query, exit
        if (queryResult.closedDuringQuery || stream.isDone) {
          break;
        }

        // Emit session update so host can track the session
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: null,
            newSessionId: sessionId,
          });
        }

        // Wait for next message in the stream
        // The stream will yield when pushMessage() is called
        // or return when end() is called
        logger.debug(
          { groupFolder: input.groupFolder },
          'Query ended, waiting for follow-up message',
        );

        let gotNext = false;
        for await (const _msg of stream) {
          // We got a new message — use it as the next prompt
          prompt = _msg.message.content;
          gotNext = true;
          break;
        }

        if (!gotNext) {
          // Stream ended
          break;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error(
        { groupFolder: input.groupFolder, error: lastError },
        'Agent error',
      );
    }

    return {
      status: lastError ? 'error' : 'success',
      result: null,
      newSessionId: sessionId,
      error: lastError,
    };
  })();

  return {
    pushMessage: (text: string) => stream.push(text),
    close: () => stream.end(),
    stream,
    done: donePromise,
  };
}
