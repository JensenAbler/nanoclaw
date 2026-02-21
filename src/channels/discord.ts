/**
 * Discord Channel Adapter for NanoClaw
 *
 * Routes Discord channel messages to nanoClaw groups.
 * Channel-to-group mapping is configured via DISCORD_CHANNEL_MAP env var
 * or defaults to: #inventory → inventory, #menu_planning → menu-planner, #shopping_lists → shopping-list
 *
 * Discord messages use virtual JIDs: `discord-{channelId}@discord`
 * These are stored in the registered_groups table alongside WhatsApp JIDs.
 */
import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  GuildMember,
  Message,
  MessageFlags,
  Partials,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { formatImageContent, saveImageToIpc } from '../media.js';
import { transcribeAudio, formatVoiceContent } from '../transcription.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

/** Image MIME types we handle */
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

/** Audio MIME types for voice messages */
const AUDIO_MIME_TYPES = new Set([
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
]);

/** Maps Discord channel names to nanoClaw group folders */
export interface ChannelMapping {
  channelName: string; // Discord channel name (without #)
  channelId?: string; // Discord channel ID (resolved at runtime)
  groupFolder: string; // nanoClaw group folder name
}

export interface DiscordChannelOpts {
  token: string;
  guildId: string; // Discord server ID
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  channelMap?: ChannelMapping[];
}

/** Default channel mapping for CKP */
// Note: Discord lowercases all channel names automatically
const DEFAULT_CHANNEL_MAP: ChannelMapping[] = [
  { channelName: 'inventory', groupFolder: 'inventory' },
  { channelName: 'menu_planning', groupFolder: 'menu-planner' },
  { channelName: 'shopping_lists', groupFolder: 'shopping-list' },
  { channelName: 'prep_lists', groupFolder: 'prep-list' },
  { channelName: 'role_assignments', groupFolder: 'role-assigner' },
  { channelName: 'day_of', groupFolder: 'day-of' },
  { channelName: 'bank', groupFolder: 'bank-tracker' },
  { channelName: 'budget', groupFolder: 'budget-tracker' },
  { channelName: 'preferences', groupFolder: 'preferences' },
  { channelName: 'messaging', groupFolder: 'messaging' },
];

/**
 * Convert a Discord channel ID to a virtual JID used internally by nanoClaw.
 * Format: discord-{channelId}@discord
 */
export function discordJid(channelId: string): string {
  return `discord-${channelId}@discord`;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;
  private channelMap: ChannelMapping[];

  // Resolved at connect time: channelId → mapping
  private resolvedChannels = new Map<string, ChannelMapping>();
  // Reverse lookup: virtual JID → channelId
  private jidToChannelId = new Map<string, string>();

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.channelMap = opts.channelMap || DEFAULT_CHANNEL_MAP;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [
        Partials.Channel, // Required for DM channels
        Partials.Message, // Required for DM messages
      ],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord connection timed out after 30s'));
      }, 30000);

      this.client.once(Events.ClientReady, async (readyClient) => {
        clearTimeout(timeout);
        this.connected = true;
        logger.info(
          { user: readyClient.user.tag },
          'Discord bot connected',
        );

        // Resolve channel names to IDs
        await this.resolveChannels();

        // Auto-register Discord channels as nanoClaw groups
        this.autoRegisterGroups();

        resolve();
      });

      this.client.on(Events.MessageCreate, (msg) => {
        this.handleMessage(msg).catch((err) => {
          logger.error({ err }, 'Error handling Discord message');
        });
      });

      // Handle disconnections
      this.client.on(Events.Error, (err) => {
        logger.error({ err }, 'Discord client error');
      });

      this.client.on(Events.ShardDisconnect, () => {
        this.connected = false;
        logger.warn('Discord disconnected');
      });

      this.client.on(Events.ShardReconnecting, () => {
        logger.info('Discord reconnecting...');
      });

      this.client.on(Events.ShardResume, () => {
        this.connected = true;
        logger.info('Discord reconnected');
      });

      this.client.login(this.opts.token).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = this.jidToChannelId.get(jid);
    if (!channelId) {
      logger.warn({ jid }, 'Cannot send Discord message: unknown JID');
      return;
    }

    const channel = this.client.channels.cache.get(channelId);
    if (!channel) {
      logger.warn({ channelId }, 'Cannot send Discord message: channel not found');
      return;
    }

    // Check if channel supports sending messages (TextChannel or DMChannel)
    if (!('send' in channel)) {
      logger.warn({ channelId, channelType: channel.type }, 'Cannot send Discord message: channel does not support sending');
      return;
    }

    // Split long messages (Discord has 2000 char limit)
    const chunks = splitMessage(text, 2000);
    for (const chunk of chunks) {
      await (channel as TextChannel).send(chunk);
    }

    logger.info({ channelId, length: text.length }, 'Discord message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@discord');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.client.destroy();
    logger.info('Discord client disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Discord typing auto-expires

    const channelId = this.jidToChannelId.get(jid);
    if (!channelId) return;

    const channel = this.client.channels.cache.get(channelId);
    if (channel instanceof TextChannel) {
      try {
        await channel.sendTyping();
      } catch (err) {
        logger.debug({ err, channelId }, 'Failed to send Discord typing indicator');
      }
    }
  }

  /**
   * Find a guild member by display name or username (case-insensitive, partial match).
   * Returns the first matching GuildMember, or null if not found.
   */
  async findMemberByName(name: string): Promise<GuildMember | null> {
    const guild = this.client.guilds.cache.get(this.opts.guildId);
    if (!guild) return null;

    // Fetch all members to ensure cache is populated
    await guild.members.fetch();

    const nameLower = name.toLowerCase();
    const match = guild.members.cache.find((m) => {
      const display = (m.displayName || '').toLowerCase();
      const username = (m.user.username || '').toLowerCase();
      return display.includes(nameLower) || username.includes(nameLower);
    });

    return match || null;
  }

  /**
   * Send a DM to a guild member by name.
   * Returns true on success, false if member not found or DM failed.
   */
  async sendDM(memberName: string, text: string): Promise<boolean> {
    const member = await this.findMemberByName(memberName);
    if (!member) {
      logger.warn({ memberName }, 'Cannot send DM: member not found in guild');
      return false;
    }

    try {
      const dmChannel = await member.user.createDM();
      const chunks = splitMessage(text, 2000);
      for (const chunk of chunks) {
        await dmChannel.send(chunk);
      }
      logger.info({ memberName, userId: member.user.id }, 'Discord DM sent');
      return true;
    } catch (err) {
      logger.error({ err, memberName }, 'Failed to send Discord DM');
      return false;
    }
  }

  /**
   * List all members in the guild. Returns array of {id, name} objects.
   */
  async listMembers(): Promise<Array<{ id: string; name: string; username: string }>> {
    const guild = this.client.guilds.cache.get(this.opts.guildId);
    if (!guild) return [];

    await guild.members.fetch();

    return guild.members.cache.map((m) => ({
      id: m.user.id,
      name: m.displayName || m.user.username,
      username: m.user.username,
    }));
  }

  /**
   * Resolve configured channel names to Discord channel IDs.
   */
  private async resolveChannels(): Promise<void> {
    const guild = this.client.guilds.cache.get(this.opts.guildId);
    if (!guild) {
      logger.error(
        { guildId: this.opts.guildId },
        'Discord guild not found — check DISCORD_GUILD_ID',
      );
      return;
    }

    // Fetch all channels to ensure cache is populated
    await guild.channels.fetch();

    for (const mapping of this.channelMap) {
      // Find channel by name
      const channel = guild.channels.cache.find(
        (c) => c.name === mapping.channelName && c instanceof TextChannel,
      );

      if (channel) {
        mapping.channelId = channel.id;
        const jid = discordJid(channel.id);
        this.resolvedChannels.set(channel.id, mapping);
        this.jidToChannelId.set(jid, channel.id);
        logger.info(
          { channel: `#${mapping.channelName}`, channelId: channel.id, group: mapping.groupFolder, jid },
          'Discord channel resolved',
        );
      } else {
        logger.warn(
          { channelName: mapping.channelName },
          'Discord channel not found in guild — create it or check the name',
        );
      }
    }
  }

  /**
   * Auto-register Discord channels as nanoClaw groups.
   * If the virtual JID isn't already registered, register it pointing
   * to the same group folder as the WhatsApp group (shared state).
   */
  private autoRegisterGroups(): void {
    const registeredGroups = this.opts.registeredGroups();

    for (const [channelId, mapping] of this.resolvedChannels) {
      const jid = discordJid(channelId);

      if (registeredGroups[jid]) {
        logger.debug(
          { jid, group: mapping.groupFolder },
          'Discord channel already registered',
        );
        continue;
      }

      // Find the existing WhatsApp group config for this folder
      // to inherit container config (ckp-tools mount, etc.)
      let containerConfig: RegisteredGroup['containerConfig'];
      for (const existing of Object.values(registeredGroups)) {
        if (existing.folder === mapping.groupFolder) {
          containerConfig = existing.containerConfig;
          break;
        }
      }

      this.opts.registerGroup(jid, {
        name: `Discord #${mapping.channelName}`,
        folder: mapping.groupFolder,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false, // Dedicated channels — every message is processed
        containerConfig,
      });

      logger.info(
        { jid, channel: `#${mapping.channelName}`, group: mapping.groupFolder },
        'Discord channel auto-registered as nanoClaw group',
      );
    }
  }

  /**
   * Handle an incoming Discord message.
   */
  private async handleMessage(msg: Message): Promise<void> {
    // Debug: log ALL incoming messages
    logger.info({
      channelId: msg.channelId,
      channelType: msg.channel.type,
      authorId: msg.author.id,
      authorName: msg.author.username,
      isBot: msg.author.bot,
      contentPreview: msg.content?.substring(0, 50),
    }, 'Discord message received');

    // Ignore bot messages (including our own)
    if (msg.author.bot) return;

    // Handle DM replies — route to dm-replies group but use user-specific JID for replies
    if (msg.channel.type === ChannelType.DM) {
      const userJid = `dm-${msg.author.id}@discord`;
      const timestamp = msg.createdAt.toISOString();
      const senderName = msg.author.displayName || msg.author.username;
      const content = msg.content;
      if (!content) return;

      // Store the DM channel ID so we can reply
      this.jidToChannelId.set(userJid, msg.channelId);

      logger.info({ userId: msg.author.id, username: msg.author.username, userJid }, 'Received Discord DM');

      // Route to dm-replies group for processing
      this.opts.onMessage('dm-replies@discord', {
        id: msg.id,
        chat_jid: userJid, // Use user-specific JID so replies go back to them
        sender: `discord-${msg.author.id}`,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      return;
    }

    // Only process messages from mapped guild channels
    const mapping = this.resolvedChannels.get(msg.channelId);
    if (!mapping) return;

    const jid = discordJid(msg.channelId);
    const timestamp = msg.createdAt.toISOString();

    // Notify about chat metadata
    this.opts.onChatMetadata(jid, timestamp, `Discord #${mapping.channelName}`);

    // Build the message
    const senderName = msg.member?.displayName || msg.author.displayName || msg.author.username;
    let content = msg.content;

    if (!content && msg.attachments.size === 0) return;

    // Handle image attachments: download and save so the agent can view them
    const imageAttachments = msg.attachments.filter(
      (a) => a.contentType && IMAGE_MIME_TYPES.has(a.contentType),
    );

    if (imageAttachments.size > 0) {
      const imageParts: string[] = [];

      for (const [, attachment] of imageAttachments) {
        try {
          const response = await fetch(attachment.url);
          if (!response.ok) {
            logger.warn(
              { url: attachment.url, status: response.status },
              'Failed to fetch Discord image attachment',
            );
            continue;
          }

          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const mimetype = attachment.contentType || 'image/jpeg';
          const msgId = `${msg.id}-${attachment.id}`;

          const containerPath = saveImageToIpc(
            buffer,
            mapping.groupFolder,
            msgId,
            mimetype,
          );

          if (containerPath) {
            imageParts.push(`[Image: ${containerPath}]`);
          }
        } catch (err) {
          logger.error(
            { err, attachmentId: attachment.id },
            'Failed to download Discord image attachment',
          );
        }
      }

      if (imageParts.length > 0) {
        // Combine image references with any text content
        const imageRefs = imageParts.join('\n');
        content = content
          ? `${imageRefs}\n${content}`
          : imageRefs;
      }
    }

    // Handle voice messages (IS_VOICE_MESSAGE flag)
    const isVoiceMessage = msg.flags?.has(MessageFlags.IsVoiceMessage);
    if (isVoiceMessage && msg.attachments.size > 0) {
      const voiceAttachment = msg.attachments.find(
        (a) => a.contentType && AUDIO_MIME_TYPES.has(a.contentType.split(';')[0]),
      );

      if (voiceAttachment) {
        try {
          const response = await fetch(voiceAttachment.url);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = Buffer.from(arrayBuffer);
            const mimetype = voiceAttachment.contentType || 'audio/ogg';

            logger.info(
              { channelId: msg.channelId, size: audioBuffer.length, mimetype },
              'Downloaded Discord voice message',
            );

            const transcript = await transcribeAudio(audioBuffer, mimetype);
            content = content
              ? `${formatVoiceContent(transcript)}\n${content}`
              : formatVoiceContent(transcript);
          } else {
            logger.warn(
              { url: voiceAttachment.url, status: response.status },
              'Failed to fetch Discord voice message',
            );
            content = content
              ? `[Voice Message - download failed]\n${content}`
              : '[Voice Message - download failed]';
          }
        } catch (err) {
          logger.error({ err }, 'Failed to process Discord voice message');
          content = content
            ? `[Voice Message - processing failed]\n${content}`
            : '[Voice Message - processing failed]';
        }
      }
    }

    this.opts.onMessage(jid, {
      id: msg.id,
      chat_jid: jid,
      sender: `discord-${msg.author.id}`,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }
}

/**
 * Split a message into chunks that fit Discord's 2000-char limit.
 * Tries to split on newlines to avoid breaking mid-sentence.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.5) {
      // Newline is too far back, try space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // No good split point, hard cut
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
