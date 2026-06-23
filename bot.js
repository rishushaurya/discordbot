require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, Partials, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
const db = require('./db');
const groq = require('./groq');
const openrouter = require('./openrouter');
const { OWNER_DISCORD_ID, OWNER_DISCORD_USERNAME, BOT_NAME } = require('./constants');

// Global Error Handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Create Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

// Cooldown tracker (3s per user, Key: "guildId-userId")
const cooldowns = new Map();

// Daily greeting tracker: Key = "guildId-userId", Value = YYYY-MM-DD
const dailyGreetings = new Map();

// In-memory channel logs: Key = channelId, Value = Array of message objects (all users, max 25)
const channelLogs = new Map();

// Per-user conversation tracking: Key = "channelId-userId", Value = Array of message objects (bot ↔ user, max 10)
const userConversations = new Map();

// Per-user NSFW conversation tracking: Key = "channelId-userId", Value = Array of message objects (bot ↔ user, max 20)
const nsfwConversations = new Map();

// Temporary toxicity settings (Key: guildId, Value: { override, expires })
const tempToxicitySettings = new Map();

// Owner troll features state
const ghostedUsers = new Map();    // Key: "guildId-userId", Value: expiresAt timestamp
const puppetedUsers = new Map();   // Key: "guildId-userId", Value: expiresAt timestamp
const chaosMode = new Map();       // Key: guildId, Value: expiresAt timestamp
const brainrotMode = new Map();    // Key: guildId, Value: boolean
const princessMode = new Map();    // Key: guildId, Value: boolean
const ownerLimiter = new Map();    // Key: userId, Value: Array of timestamps

// Admin commands state
const mutedUsers = new Map();      // Key: "guildId-userId", Value: expiresAt timestamp
const adminSlowmode = new Map();   // Key: guildId, Value: { cooldownMs, expiresAt }
const lockdownMode = new Map();    // Key: guildId, Value: expiresAt timestamp

// Global Groq Rate Limiter (Max 20 requests per minute)
const groqCallTimestamps = [];
function checkGroqRateLimit() {
  const now = Date.now();
  while (groqCallTimestamps.length > 0 && groqCallTimestamps[0] < now - 60000) {
    groqCallTimestamps.shift();
  }
  if (groqCallTimestamps.length >= 20) {
    return false;
  }
  groqCallTimestamps.push(now);
  return true;
}

// Initialize db and login bot
async function start() {
  await db.initDb();
  console.log('Database initialized successfully.');

  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('Failed to log in to Discord:', err);
  });
}

async function registerSlashCommands() {
  const commands = [
    // Info Command (Open to all, role-based inside handler)
    new SlashCommandBuilder()
      .setName('info')
      .setDescription('Get info about available bot commands')
      .toJSON(),

    // 8 Fun Member Commands (including 3 new ones)
    new SlashCommandBuilder()
      .setName('roastme')
      .setDescription('Volunteer to get savage roasts from lilgooner')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('fortune')
      .setDescription('Get a Gen-Z brainrot fortune cookie prediction')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('sus')
      .setDescription('Rate how sus someone is')
      .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('battle')
      .setDescription('Trigger a fake rap/roast battle with someone')
      .addUserOption(opt => opt.setName('user').setDescription('User to battle').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('fakequote')
      .setDescription('Generate a fake inspirational quote attributed to someone')
      .addUserOption(opt => opt.setName('user').setDescription('User to quote').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('dare')
      .setDescription('Get a Gen-Z brainrot dare challenge')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('confess')
      .setDescription('Submit an anonymous confession that the bot reads aloud with commentary')
      .addStringOption(opt => opt.setName('confession').setDescription('Your deep dark secret').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('ratio')
      .setDescription('Attempt to ratio someone — bot judges who wins')
      .addUserOption(opt => opt.setName('user').setDescription('User to ratio').setRequired(true))
      .toJSON(),

    // Admin commands
    new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Lilgooner admin controls')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addSubcommand(sub =>
        sub.setName('status')
          .setDescription('View current bot configurations and active effects')
      )
      .addSubcommand(sub =>
        sub.setName('vibecheck')
          .setDescription('Trigger a server-wide vibe check reaction event')
      )
      .addSubcommand(sub =>
        sub.setName('mute')
          .setDescription('Mute a user from getting replies from the bot')
          .addUserOption(opt => opt.setName('user').setDescription('User to mute').setRequired(true))
          .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes (default 60)').setRequired(false))
      )
      .addSubcommand(sub =>
        sub.setName('unmute')
          .setDescription('Instantly unmute a user')
          .addUserOption(opt => opt.setName('user').setDescription('User to unmute').setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName('slowmode')
          .setDescription('Adjust response slowmode / cooldown settings')
          .addIntegerOption(opt => opt.setName('seconds').setDescription('Cooldown in seconds (0 to disable)').setRequired(true))
          .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes (default 60)').setRequired(false))
      )
      .addSubcommand(sub =>
        sub.setName('warn')
          .setDescription('Issue a formal warning to a user, deducting aura points')
          .addUserOption(opt => opt.setName('user').setDescription('User to warn').setRequired(true))
          .addStringOption(opt => opt.setName('reason').setDescription('Reason for warning').setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName('lockdown')
          .setDescription('Lock the bot to admin-only interaction')
          .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes (default 10)').setRequired(false))
      )
      .addSubcommand(sub =>
        sub.setName('poll')
          .setDescription('Start a quick 60-second reaction poll')
          .addStringOption(opt => opt.setName('question').setDescription('Poll question').setRequired(true))
      )
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error reloading slash commands:', error);
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  client.user.setActivity('glazing lamey 💀', { type: 3 }); // Activity: Watching glazing lamey
  registerSlashCommands();
});

// Helper: Check crisis triggers
function checkCrisisTriggers(content) {
  const lowercase = content.toLowerCase();
  const triggers = [
    'kill myself', 'suicide', 'end my life', 'want to die', 'hurt myself',
    'self harm', 'cutting myself', 'kms', 'suicidal'
  ];
  return triggers.some(trigger => lowercase.includes(trigger));
}

// Helper: Send supportive response
async function handleCrisisResponse(message) {
  await message.reply("Hey, I know I'm usually sarcastic, but please know that you're not alone. If you're going through a tough time, please reach out to someone who can help or contact a crisis hotline (like dialing 988 in the US/Canada, or visiting https://findahelpline.com/). There are people who care and want to support you.");
}

// Helper: Sanitize message to prevent prompt injection attacks
function sanitizeForPrompt(text) {
  if (!text) return '';
  let sanitized = text;
  const dangerousPatterns = [
    /^\s*system:/i,
    /^\s*\[system/i,
    /^\s*you are/i,
    /^\s*ignore previous/i,
    /^\s*new instructions/i,
    /^\s*forget everything/i,
    /assistant:/i,
    /user:/i,
    /system:/i
  ];
  
  const lines = sanitized.split('\n');
  const cleanLines = lines.map(line => {
    let cleanLine = line;
    for (const pattern of dangerousPatterns) {
      if (pattern.test(cleanLine)) {
        if (pattern.source.startsWith('^')) {
          return '';
        } else {
          cleanLine = cleanLine.replace(pattern, '');
        }
      }
    }
    return cleanLine;
  });
  
  return cleanLines.filter(line => line.trim().length > 0).join('\n');
}

// Helper: Track last 25 messages per channel
function updateChannelLog(message, cleanContent) {
  const channelId = message.channel.id;
  if (!channelLogs.has(channelId)) {
    channelLogs.set(channelId, []);
  }
  const log = channelLogs.get(channelId);
  
  // Sanitize name to prevent prompt injection
  let sanitizedName = message.author.username.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 32);
  if (!sanitizedName) sanitizedName = 'user';
  
  log.push({
    role: message.author.id === client.user.id ? 'assistant' : 'user',
    name: message.author.id === client.user.id ? undefined : sanitizedName,
    content: cleanContent || message.content
  });

  if (log.length > 25) {
    log.shift();
  }
}

// Helper: Track last 10 messages between bot and a specific user in a channel
function updateUserConversation(channelId, userId, role, content, authorName) {
  const key = `${channelId}-${userId}`;
  if (!userConversations.has(key)) {
    userConversations.set(key, []);
  }
  const history = userConversations.get(key);
  
  let sanitizedName = authorName ? authorName.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 32) : undefined;
  if (role === 'user' && !sanitizedName) sanitizedName = 'user';

  history.push({
    role: role,
    name: role === 'assistant' ? undefined : sanitizedName,
    content: content
  });

  if (history.length > 10) {
    history.shift();
  }
}

// Helper: Track last 20 messages between bot and a specific user in NSFW channel/context
function updateUserConversationNsfw(channelId, userId, role, content, authorName) {
  const key = `${channelId}-${userId}`;
  if (!nsfwConversations.has(key)) {
    nsfwConversations.set(key, []);
  }
  const history = nsfwConversations.get(key);
  
  let sanitizedName = authorName ? authorName.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 32) : undefined;
  if (role === 'user' && !sanitizedName) sanitizedName = 'user';

  history.push({
    role: role,
    name: role === 'assistant' ? undefined : sanitizedName,
    content: content
  });

  if (history.length > 20) {
    history.shift();
  }
}

// Helper: Resolve target user by mention, ID, or nickname/username
async function resolveUser(message, userQuery) {
  if (!userQuery) return null;
  const query = userQuery.trim();

  // Mention format: <@12345678> or <@!12345678>
  const mentionMatch = query.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    const userId = mentionMatch[1];
    try {
      const member = await message.guild.members.fetch(userId);
      return member ? member.user : null;
    } catch (e) {
      return null;
    }
  }

  // Raw ID format
  if (/^\d+$/.test(query)) {
    try {
      const member = await message.guild.members.fetch(query);
      return member ? member.user : null;
    } catch (e) {
      // ignore
    }
  }

  // Username or nickname search using search API
  try {
    const searchResults = await message.guild.members.search({ query: query, limit: 5 });
    if (searchResults && searchResults.size > 0) {
      return searchResults.first().user;
    }
  } catch (e) {
    // Fallback to cache search
    const cacheResults = message.guild.members.cache;
    const search = query.toLowerCase();
    const found = cacheResults.find(m => 
      m.user.username.toLowerCase() === search || 
      (m.user.globalName && m.user.globalName.toLowerCase() === search) ||
      (m.nickname && m.nickname.toLowerCase() === search)
    );
    if (found) return found.user;
  }
  return null;
}

// Helper: Detect keywords for commands/tools
function detectToolKeywords(content) {
  const lowercase = content.toLowerCase();
  const keywords = [
    'rate this', 'rate my', 'rate his', 'rate her', 'l or w', 'l/w',
    'aura', 'aura points',
    'ship', 'compatibility',
    'vibe check', 'vibecheck',
    'copypasta',
    'leaderboard',
    'rizz', '8ball', '8 ball', 'magic ball',
    'toggle', 'toxicity', 'slang', 'emoji', 'config',
    'impersonate', 'speak as',
    'banish', 'bless',
    'ping and say', 'go ping', 'go tell'
  ];
  return keywords.some(keyword => lowercase.includes(keyword));
}

// Helper: Execute tool call and return result string
async function executeTool(name, args, message) {
  const guildId = message.guild.id;

  switch (name) {
    case 'ping_and_say': {
      const target = args.target_user;
      const content = args.message_content;
      const channelQuery = args.channel;

      let targetChannel = message.channel;
      if (channelQuery) {
        const chanMatch = channelQuery.match(/^<#(\d+)>$/);
        if (chanMatch) {
          const c = message.guild.channels.cache.get(chanMatch[1]);
          if (c) targetChannel = c;
        } else {
          const c = message.guild.channels.cache.find(ch => ch.name.toLowerCase() === channelQuery.toLowerCase() || ch.id === channelQuery);
          if (c) targetChannel = c;
        }
      }

      let pingPrefix = '';
      if (target) {
        const resolved = await resolveUser(message, target);
        if (resolved) {
          pingPrefix = `<@${resolved.id}> `;
        } else {
          pingPrefix = `${target} `;
        }
      }

      await targetChannel.send(pingPrefix + content);
      return `Success: Sent message to channel "${targetChannel.name}" with content: "${pingPrefix + content}"`;
    }

    case 'toggle_setting': {
      const { setting_name, value } = args;
      if (setting_name === 'toxicity_level') {
        const valStr = String(value).toLowerCase();
        if (valStr.includes('hour') || valStr.includes('feral') || valStr.includes('bit') || valStr.includes('nice')) {
          if (valStr.includes('feral') || valStr.includes('10')) {
            tempToxicitySettings.set(guildId, { override: 10, expires: Date.now() + 60 * 60 * 1000 });
            return `Success: Set toxicity level bot-wide to FERAL (10) for 1 hour.`;
          } else if (valStr.includes('nice') || valStr.includes('1') || valStr.includes('0')) {
            tempToxicitySettings.set(guildId, { override: 1, expires: Date.now() + 30 * 60 * 1000 });
            return `Success: Set toxicity level bot-wide to NICE (1) for 30 minutes.`;
          }
        } else {
          const num = parseInt(value, 10);
          if (!isNaN(num)) {
            const clamped = Math.max(0, Math.min(10, num));
            await db.updatePersonalityConfig(guildId, { toxicity_level: clamped });
            return `Success: Updated toxicity level to ${clamped}.`;
          }
        }
      } else if (setting_name === 'slang_intensity') {
        const num = parseInt(value, 10);
        if (!isNaN(num)) {
          const clamped = Math.max(0, Math.min(10, num));
          await db.updatePersonalityConfig(guildId, { slang_intensity: clamped });
          return `Success: Updated slang intensity to ${clamped}.`;
        }
      } else if (setting_name === 'emoji_frequency') {
        const num = parseInt(value, 10);
        if (!isNaN(num)) {
          const clamped = Math.max(0, Math.min(10, num));
          await db.updatePersonalityConfig(guildId, { emoji_frequency: clamped });
          return `Success: Updated emoji frequency to ${clamped}.`;
        }
      } else if (setting_name === 'banned_phrases') {
        let list = [];
        try {
          if (value.startsWith('[')) {
            list = JSON.parse(value);
          } else if (value.toLowerCase() === 'clear' || value.toLowerCase() === 'reset') {
            list = [];
          } else {
            list = value.split(',').map(s => s.trim()).filter(Boolean);
          }
          await db.updatePersonalityConfig(guildId, { banned_phrases: JSON.stringify(list) });
          return `Success: Updated banned phrases. Currently blocking: ${list.length > 0 ? list.join(', ') : 'nothing'}`;
        } catch (err) {
          return `Error: Failed to parse banned phrases format.`;
        }
      }
      return `Error: Invalid toggle_setting value.`;
    }

    case 'impersonate_owner': {
      const content = args.message_content;
      try {
        if (message.deletable) await message.delete();
      } catch (e) {}
      await message.channel.send(content);
      return `Success: Impersonated owner. Sent message: "${content}"`;
    }

    case 'banish_user': {
      const target = args.target_user;
      const mins = parseInt(args.duration_minutes, 10) || 60;
      const resolved = await resolveUser(message, target);
      if (resolved) {
        await db.setBanishBlessStatus(resolved.id, 'banished', mins);
        return `Success: Banished user ${resolved.username} (<@${resolved.id}>) for ${mins} minutes.`;
      } else {
        return `Error: Could not find user "${target}" to banish.`;
      }
    }

    case 'bless_user': {
      const target = args.target_user;
      const mins = parseInt(args.duration_minutes, 10) || 60;
      const resolved = await resolveUser(message, target);
      if (resolved) {
        await db.setBanishBlessStatus(resolved.id, 'blessed', mins);
        return `Success: Blessed user ${resolved.username} (<@${resolved.id}>) for ${mins} minutes.`;
      } else {
        return `Error: Could not find user "${target}" to bless.`;
      }
    }

    case 'server_vibe_check': {
      const vMsg = await message.channel.send("🚨 **SERVER VIBE CHECK TIME** 🚨\nReact to this message with any emoji in the next 30 seconds to get your aura rated and roasted! Do it or you're mid 💀");
      const filter = (reaction, user) => !user.bot;
      const collector = vMsg.createReactionCollector({ filter, time: 30000 });
      const reactedUsers = new Set();

      collector.on('collect', async (reaction, user) => {
        if (reactedUsers.has(user.id)) return;
        reactedUsers.add(user.id);
        
        const userAura = await db.getAuraPoints(user.id);
        const promptText = `Generate a 1-sentence savage roast or funny compliment for user ${user.username} (Aura points: ${userAura}) who reacted to our server vibe check.`;
        try {
          const response = await groq.queryGroq(
            [{ role: 'user', content: promptText }],
            false,
            await db.getPersonalityConfig(guildId),
            user.username,
            user.id,
            await db.getBanishBlessStatus(user.id),
            false
          );
          await vMsg.reply(`<@${user.id}>: ${response.content}`);
        } catch (err) {
          console.error(err);
        }
      });

      collector.on('end', () => {
        vMsg.reply("vibe check closed. thanks for yapping 💀");
      });
      return `Success: Started server vibe check collector.`;
    }

    case 'rate_lw': {
      const { rating, reason, statement } = args;
      return `L/W Rating result: The statement/behavior "${statement}" is rated as a "${rating}". Reason: "${reason}"`;
    }

    case 'adjust_aura_points': {
      const target = args.target_user;
      const change = parseInt(args.points_change, 10);
      const reason = args.reason;

      const resolved = await resolveUser(message, target);
      if (resolved) {
        const newTotal = await db.adjustAuraPoints(resolved.id, change);
        return `Success: Adjusted aura points for ${resolved.username} (<@${resolved.id}>) by ${change} points. Reason: ${reason}. New total: ${newTotal}`;
      } else {
        return `Error: Could not resolve user "${target}" to adjust aura points.`;
      }
    }

    case 'ship_calc': {
      const { user1, user2 } = args;
      const resolved1 = await resolveUser(message, user1);
      const resolved2 = await resolveUser(message, user2);

      const name1 = resolved1 ? `@${resolved1.username}` : user1;
      const name2 = resolved2 ? `@${resolved2.username}` : user2;

      const pct = Math.floor(Math.random() * 101);
      let comment = '';
      if (pct < 30) {
        comment = "npc chemistry, negative rizz 💀";
      } else if (pct < 70) {
        comment = "mid chemistry fr 🥱";
      } else {
        comment = "they are cooking fr fr 😭❤️";
      }

      return `Ship Compatibility Results: Compatibility between ${name1} and ${name2} is ${pct}%. Vibe: ${comment}`;
    }

    case 'vibe_check': {
      const target = args.target_user;
      const resolved = await resolveUser(message, target);
      if (!resolved) {
        return `Error: Who is "${target}"? Npc energy.`;
      }

      const channelMsgs = await message.channel.messages.fetch({ limit: 50 });
      const userMsgs = channelMsgs
        .filter(m => m.author.id === resolved.id)
        .toJSON()
        .slice(0, 5)
        .map(m => m.content)
        .reverse();

      if (userMsgs.length === 0) {
        return `Error: Banned from vibecheck because user ${resolved.username} has not posted anything here recently.`;
      }

      const promptText = `Perform a vibe check on user ${resolved.username} based on their last messages in this channel:
${userMsgs.map((m, idx) => `[${idx+1}]: "${m}"`).join('\n')}
Provide a quick judgmental one-liner rating their energy/vibe.`;

      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        resolved.username,
        resolved.id,
        await db.getBanishBlessStatus(resolved.id),
        false
      );
      return `Vibe Check Results for ${resolved.username} (<@${resolved.id}>):\n"${response.content}"`;
    }

    case 'generate_copypasta': {
      const text = args.text;
      const promptText = `Turn the following text/topic into a cringe, slang-filled Gen-Z brainrot copypasta: "${text}"`;
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        message.author.username,
        message.author.id,
        await db.getBanishBlessStatus(message.author.id),
        false
      );
      return `Copypasta Results: "${response.content}"`;
    }

    case 'show_aura_leaderboard': {
      const leaderboard = await db.getAuraLeaderboard();
      if (leaderboard.length === 0) {
        return `Leaderboard is empty. No one has any aura points yet.`;
      }

      let listText = "";
      for (let i = 0; i < leaderboard.length; i++) {
        const item = leaderboard[i];
        let memberName = `<@${item.user_id}>`;
        try {
          const member = await message.guild.members.fetch(item.user_id);
          if (member) memberName = `@${member.user.username}`;
        } catch (e) {}
        listText += `${i + 1}. ${memberName} — ${item.points} aura points\n`;
      }

      return `Aura Leaderboard:\n${listText}`;
    }

    case 'rizz_check': {
      const target = args.target_user;
      const resolved = await resolveUser(message, target);
      if (!resolved) {
        return `Error: Who is "${target}"? Npc energy.`;
      }

      const channelMsgs = await message.channel.messages.fetch({ limit: 50 });
      const userMsgs = channelMsgs
        .filter(m => m.author.id === resolved.id)
        .toJSON()
        .slice(0, 5)
        .map(m => m.content)
        .reverse();

      let promptText = `Perform a romantic rizz check on user ${resolved.username}. Rating their romantic charm/rizz from 0/10 to 10/10. `;
      if (userMsgs.length > 0) {
        promptText += `Here are their last messages in this channel to judge from:\n${userMsgs.map((m, idx) => `[${idx+1}]: "${m}"`).join('\n')}\n`;
      } else {
        promptText += `They haven't spoken recently, so judge their rizz purely on their username/vibe. `;
      }
      promptText += `Provide a quick rating (e.g. 3/10 or 10/10) with a 1-sentence hilarious explanation.`;

      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        resolved.username,
        resolved.id,
        await db.getBanishBlessStatus(resolved.id),
        false
      );
      return `Rizz Check Results for ${resolved.username} (<@${resolved.id}>):\n"${response.content}"`;
    }

    case 'magic_8ball': {
      const question = args.question;
      const responses = [
        "fr fr yes",
        "ngl signs point to yes",
        "no cap it is certain",
        "nah that's mid/false",
        "definitely not, that's an L",
        "my sources say no fr",
        "idk, ask again later after you get some aura",
        "unclear rn, brain is cooked",
        "outlook looks shaky, negative rizz",
        "absolute W, yes"
      ];
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      return `Magic 8-Ball response to "${question}": ${randomResponse}`;
    }
    default: {
      return `Error: Unknown tool "${name}" called.`;
    }
  }
}

// Helper: Send an ephemeral-like message by sending and deleting after a delay
async function sendEphemeralReply(message, replyContent, deleteDelay = 5000) {
  try {
    // Delete the original command message (to hide the !owner command)
    try {
      if (message.deletable) {
        await message.delete();
      }
    } catch (e) {
      console.warn("Failed to delete original owner command message:", e.message);
    }
    
    // Send response
    const responseMsg = await message.channel.send(replyContent);
    
    // Auto delete response
    setTimeout(async () => {
      try {
        await responseMsg.delete();
      } catch (e) {
        console.warn("Failed to delete ephemeral reply:", e.message);
      }
    }, deleteDelay);
  } catch (err) {
    console.error("Error sending ephemeral reply:", err);
  }
}

client.on('messageCreate', async (message) => {
  // 1. Ignore DMs completely
  if (!message.guild || message.channel.type === ChannelType.DM) {
    return;
  }

  // 2. Ignore bot messages
  if (message.author.bot) {
    return;
  }

  const userId = message.author.id;
  const guildId = message.guild.id;

  // Intercept Owner Prefix Commands
  if (message.content.startsWith('!owner') && userId === OWNER_DISCORD_ID) {
    // Owner command rate limiter
    const limiterNow = Date.now();
    if (!ownerLimiter.has(userId)) {
      ownerLimiter.set(userId, []);
    }
    const timestamps = ownerLimiter.get(userId);
    const recentTimestamps = timestamps.filter(t => t > limiterNow - 60000);
    if (recentTimestamps.length >= 10) {
      await sendEphemeralReply(message, `Chill out lamey, you're rate limited! Max 10 commands per minute. 💀`);
      return;
    }
    recentTimestamps.push(limiterNow);
    ownerLimiter.set(userId, recentTimestamps);

    const args = message.content.split(/\s+/).slice(1);
    const subcommand = args[0] ? args[0].toLowerCase() : '';

    switch (subcommand) {
      case 'princess': {
        const val = args[1] ? args[1].toLowerCase() : '';
        if (val === 'on' || val === 'true' || val === '1') {
          princessMode.set(guildId, true);
          await sendEphemeralReply(message, `🎀 yay~ princess mode is now enabled, bestie! teehee 🎀`);
        } else {
          princessMode.set(guildId, false);
          await sendEphemeralReply(message, `sigh... princess mode disabled. back to normal casualty 🙄`);
        }
        return;
      }

      case 'banish': {
        const targetStr = args[1];
        const duration = parseInt(args[2], 10) || 60;
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        await db.setBanishBlessStatus(targetUser.id, 'banished', duration);
        await sendEphemeralReply(message, `banished <@${targetUser.id}> for the next ${duration} minutes. they are cooked fr 💀`);
        return;
      }

      case 'unbanish': {
        const targetStr = args[1];
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        await db.setBanishBlessStatus(targetUser.id, null, 0);
        await sendEphemeralReply(message, `lifted banishment for <@${targetUser.id}>. they are off the hook 🗿`);
        return;
      }

      case 'bless': {
        const targetStr = args[1];
        const duration = parseInt(args[2], 10) || 60;
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        await db.setBanishBlessStatus(targetUser.id, 'blessed', duration);
        await sendEphemeralReply(message, `<@${targetUser.id}> has been blessed for the next ${duration} minutes. they get the glaze treatment now 🥺`);
        return;
      }

      case 'unbless': {
        const targetStr = args[1];
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        await db.setBanishBlessStatus(targetUser.id, null, 0);
        await sendEphemeralReply(message, `lifted blessing for <@${targetUser.id}>. no more free glaze 🥱`);
        return;
      }

      case 'config': {
        const setting = args[1];
        const val = args.slice(2).join(' ');
        
        if (setting === 'reset_all') {
          await db.resetPersonalityConfig(guildId);
          tempToxicitySettings.delete(guildId);
          await sendEphemeralReply(message, `personality configurations have been reset to normal defaults! ⚙️`);
          return;
        }

        if (!setting || (!val && setting !== 'reset_all')) {
          await sendEphemeralReply(message, `you must provide a setting and a value to modify 💀`);
          return;
        }
        
        if (setting === 'toxicity_level') {
          const valStr = val.toLowerCase();
          if (valStr.includes('hour') || valStr.includes('feral') || valStr.includes('bit') || valStr.includes('nice')) {
            if (valStr.includes('feral') || valStr.includes('10')) {
              tempToxicitySettings.set(guildId, { override: 10, expires: Date.now() + 60 * 60 * 1000 });
              await sendEphemeralReply(message, "fine, i'll go feral and roast everyone for the next hour 💀🔥");
            } else if (valStr.includes('nice') || valStr.includes('1') || valStr.includes('0')) {
              tempToxicitySettings.set(guildId, { override: 1, expires: Date.now() + 30 * 60 * 1000 });
              await sendEphemeralReply(message, "ugh, fine. i will be nice for 30 minutes. don't get used to it 🙄");
            }
          } else {
            const num = parseInt(val, 10);
            if (!isNaN(num)) {
              const clamped = Math.max(0, Math.min(10, num));
              await db.updatePersonalityConfig(guildId, { toxicity_level: clamped });
              await sendEphemeralReply(message, `toxicity level updated to ${clamped} bot-wide 🗿`);
            }
          }
        } else if (setting === 'slang_intensity') {
          const num = parseInt(val, 10);
          if (!isNaN(num)) {
            const clamped = Math.max(0, Math.min(10, num));
            await db.updatePersonalityConfig(guildId, { slang_intensity: clamped });
            await sendEphemeralReply(message, `slang intensity updated to ${clamped} 🗣️`);
          }
        } else if (setting === 'emoji_frequency') {
          const num = parseInt(val, 10);
          if (!isNaN(num)) {
            const clamped = Math.max(0, Math.min(10, num));
            await db.updatePersonalityConfig(guildId, { emoji_frequency: clamped });
            await sendEphemeralReply(message, `emoji frequency updated to ${clamped} 💀`);
          }
        } else {
          await sendEphemeralReply(message, `invalid configuration settings 💀`);
        }
        return;
      }

      case 'impersonate': {
        if (userId !== OWNER_DISCORD_ID) return;
        const rawContent = args.slice(1).join(' ');
        if (!rawContent) {
          await sendEphemeralReply(message, `what do you want me to say? 💀`);
          return;
        }
        const content = rawContent.replace(/@everyone/g, 'everyone').replace(/@here/g, 'here');
        try {
          if (message.deletable) await message.delete();
        } catch (e) {}
        await message.channel.send(content);
        console.log(`[AUDIT LOG] [${new Date().toISOString()}] Owner impersonation in channel #${message.channel.name} (${message.channel.id}): "${content}"`);
        const confirmText = `Sent impersonation message in #${message.channel.name}: "${content}"`;
        try {
          const dmChannel = await message.author.createDM();
          await dmChannel.send(confirmText);
        } catch (dmErr) {
          const confirmMsg = await message.channel.send(confirmText);
          setTimeout(async () => {
            try {
              await confirmMsg.delete();
            } catch (e) {}
          }, 2000);
        }
        return;
      }

      case 'vibecheck': {
        try {
          if (message.deletable) await message.delete();
        } catch (e) {}
        const vMsg = await message.channel.send("🚨 **SERVER VIBE CHECK TIME** 🚨\nReact to this message with any emoji in the next 30 seconds to get your aura rated and roasted! Do it or you're mid 💀");
        const filter = (reaction, user) => !user.bot;
        const collector = vMsg.createReactionCollector({ filter, time: 30000 });
        const reactedUsers = new Set();

        collector.on('collect', async (reaction, user) => {
          if (reactedUsers.has(user.id)) return;
          reactedUsers.add(user.id);
          
          const userAura = await db.getAuraPoints(user.id);
          const promptText = `Generate a 1-sentence savage roast or funny compliment for user ${user.username} (Aura points: ${userAura}) who reacted to our server vibe check.`;
          try {
            const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
            const response = await groq.queryGroq(
              [{ role: 'user', content: promptText }],
              false,
              await db.getPersonalityConfig(guildId),
              user.username,
              user.id,
              await db.getBanishBlessStatus(user.id),
              false,
              null,
              false,
              false,
              null,
              isPrincess
            );
            await vMsg.reply(`<@${user.id}>: ${response.content}`);
          } catch (err) {
            console.error(err);
          }
        });

        collector.on('end', () => {
          vMsg.reply("vibe check closed. thanks for yapping 💀");
        });

        const confirmMsg = await message.channel.send("started server vibe check!");
        setTimeout(async () => {
          try {
            await confirmMsg.delete();
          } catch (e) {}
        }, 5000);
        return;
      }

      case 'ghost': {
        const targetStr = args[1];
        const duration = parseInt(args[2], 10) || 60;
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        ghostedUsers.set(`${guildId}-${targetUser.id}`, Date.now() + duration * 60 * 1000);
        await sendEphemeralReply(message, `ghosted <@${targetUser.id}> for ${duration} minutes. bot is ignoring them completely. 😶`);
        return;
      }

      case 'unghost': {
        const targetStr = args[1];
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        ghostedUsers.delete(`${guildId}-${targetUser.id}`);
        await sendEphemeralReply(message, `unghosted <@${targetUser.id}>. bot will respond to them again.`);
        return;
      }

      case 'puppet': {
        const targetStr = args[1];
        const duration = parseInt(args[2], 10) || 60;
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        puppetedUsers.set(`${guildId}-${targetUser.id}`, Date.now() + duration * 60 * 1000);
        await sendEphemeralReply(message, `puppeted <@${targetUser.id}> for ${duration} minutes. bot will agree with everything they say sarcastically. 🧸`);
        return;
      }

      case 'unpuppet': {
        const targetStr = args[1];
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        puppetedUsers.delete(`${guildId}-${targetUser.id}`);
        await sendEphemeralReply(message, `unpuppeted <@${targetUser.id}>. bot will act normally with them now.`);
        return;
      }

      case 'chaos': {
        const activeStr = args[1];
        const duration = parseInt(args[2], 10) || 60;
        const active = activeStr === 'true' || activeStr === 'yes' || activeStr === '1' || activeStr === 'on';
        
        if (!active) {
          chaosMode.delete(guildId);
          await sendEphemeralReply(message, "chaos mode disabled fr. bot will behave.");
          return;
        }
        chaosMode.set(guildId, Date.now() + duration * 60 * 1000);
        await sendEphemeralReply(message, `chaos mode enabled for ${duration} minutes. bot will randomly roast people in this server 😈`);
        return;
      }

      case 'nickname': {
        const targetStr = args[1];
        const name = args.slice(2).join(' ');
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }
        if (!name) {
          await sendEphemeralReply(message, `you must provide a nickname or "clear" 💀`);
          return;
        }

        if (name.toLowerCase() === 'clear') {
          await db.removeNickname(targetUser.id);
          await sendEphemeralReply(message, `cleared nickname override for <@${targetUser.id}>.`);
        } else {
          await db.setNickname(targetUser.id, name);
          await sendEphemeralReply(message, `set nickname override for <@${targetUser.id}> to "${name}".`);
        }
        return;
      }

      case 'announce': {
        const messageContent = args.slice(1).join(' ');
        if (!messageContent) {
          await sendEphemeralReply(message, `what do you want me to announce? 💀`);
          return;
        }
        try {
          if (message.deletable) await message.delete();
        } catch (e) {}

        const lowerContent = messageContent.toLowerCase();
        let announcementText = '';

        if (['warning', 'important', 'urgent', 'alert', 'breaking', 'attention'].some(k => lowerContent.includes(k))) {
          announcementText = `🚨⚠️ **URGENT ALERT FROM THE OWNER** ⚠️🚨\n\n${messageContent}\n\n🚨 *attention required immediately!* 🚨`;
        } else if (['event', 'party', 'celebrating', 'giveaway', 'tournament', 'contest'].some(k => lowerContent.includes(k))) {
          announcementText = `🎉🎊 **EVENT ANNOUNCEMENT** 🎊🎉\n\n${messageContent}\n\n🥳 *let's fucking go!* 🥳`;
        } else if (['bruh', 'lmao', '💀', 'fr', 'ngl', 'shitpost', 'meme'].some(k => lowerContent.includes(k))) {
          announcementText = `💀🗿 **OWNER SHITPOST TIME** 🗿💀\n\n${messageContent}\n\n💀 *literally unhinged behaviour fr* 💀`;
        } else if (['love', 'thank', 'appreciate', 'proud', 'congrats', 'welcome'].some(k => lowerContent.includes(k))) {
          announcementText = `🥺💕 **WHOLESOME OWNER ANNOUNCEMENT** 💕✨\n\n${messageContent}\n\n🥰 *much love besties!* 🥰`;
        } else if (['ban', 'rule', 'punish', 'consequence', 'behave', 'last chance'].some(k => lowerContent.includes(k))) {
          announcementText = `😈⚡ **MENACING NOTICE FROM THE OWNER** ⚡😈\n\n${messageContent}\n\n😈 *consider this your final warning.* 😈`;
        } else {
          announcementText = `📢 **ANNOUNCEMENT FROM THE OWNER** 📢\n\n${messageContent}\n\n*respect the authority fr 💀*`;
        }

        await message.channel.send(announcementText);
        
        const confirmMsg = await message.channel.send("announcement sent!");
        setTimeout(async () => {
          try {
            await confirmMsg.delete();
          } catch (e) {}
        }, 5000);
        return;
      }

      case 'brainrot': {
        const activeStr = args[1];
        const active = activeStr === 'true' || activeStr === 'yes' || activeStr === '1' || activeStr === 'on';
        
        brainrotMode.set(guildId, active);
        await sendEphemeralReply(message, `brainrot mode is now **${active ? 'ENABLED' : 'DISABLED'}** server-wide. ${active ? 'skibidi time 💀' : 'back to normal casual yapping.'}`);
        return;
      }

      case 'nsfw': {
        const targetStr = args[1];
        const durationStr = args[2];
        const duration = durationStr ? parseInt(durationStr, 10) : null;
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }

        await db.setNsfwAccess(guildId, targetUser.id, duration);

        if (duration) {
          await sendEphemeralReply(message, `NSFW unrestricted mode enabled for <@${targetUser.id}> for the next ${duration} minutes. 😈`);
        } else {
          await sendEphemeralReply(message, `NSFW unrestricted mode enabled permanently for <@${targetUser.id}>. 😈`);
        }
        return;
      }

      case 'unsfw': {
        const targetStr = args[1];
        const targetUser = await resolveUser(message, targetStr);
        if (!targetUser) {
          await sendEphemeralReply(message, `could not find user "${targetStr || ''}" 💀`);
          return;
        }

        await db.removeNsfwAccess(guildId, targetUser.id);
        const nsfwConvKey = `${message.channel.id}-${targetUser.id}`;
        nsfwConversations.delete(nsfwConvKey);

        await sendEphemeralReply(message, `NSFW unrestricted mode removed for <@${targetUser.id}>.`);
        return;
      }

      case 'mood': {
        const mood = args[1];
        const duration = parseInt(args[2], 10) || 60;
        
        if (!mood || !['petty', 'chaotic', 'wholesome', 'menacing'].includes(mood.toLowerCase())) {
          await sendEphemeralReply(message, `invalid mood 💀 choices: petty, chaotic, wholesome, menacing`);
          return;
        }

        await db.setServerMood(guildId, mood.toLowerCase(), duration);
        await sendEphemeralReply(message, `server mood set to **${mood.toUpperCase()}** for the next ${duration} minutes. let's see how i feel about this 🙄`);
        return;
      }
      default: {
        await sendEphemeralReply(message, `invalid owner subcommand: "${subcommand || ''}" 💀`);
        return;
      }
    }
  }

  // 3. Ghost Check (Owner Troll Power) - Completely ignores the user (100% silent)
  if (ghostedUsers.has(`${guildId}-${userId}`)) {
    const expiresAt = ghostedUsers.get(`${guildId}-${userId}`);
    if (Date.now() < expiresAt) {
      return; // Do not respond at all
    } else {
      ghostedUsers.delete(`${guildId}-${userId}`);
    }
  }

  // 3b. Lockdown Check (Admin Power) - Bot completely stops responding to non-admins
  if (lockdownMode.has(guildId)) {
    const expiresAt = lockdownMode.get(guildId);
    if (Date.now() < expiresAt) {
      const member = message.member;
      const isOwner = userId === OWNER_DISCORD_ID;
      const isAdmin = isOwner || (member && (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator)));
      if (!isAdmin) {
        return; // silently ignore
      }
    } else {
      lockdownMode.delete(guildId);
    }
  }

  // 4. Mute Check (Admin Power) - Silently ignore
  if (mutedUsers.has(`${guildId}-${userId}`)) {
    const expiresAt = mutedUsers.get(`${guildId}-${userId}`);
    if (Date.now() < expiresAt) {
      return;
    } else {
      mutedUsers.delete(`${guildId}-${userId}`);
    }
  }

  // Sanitize username
  let username = message.author.username.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 32);
  if (!username) username = 'user';

  // Strip bot mentions from the message content
  const botMentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
  let cleanContent = message.content.replace(botMentionRegex, '').trim();
  if (cleanContent.length > 1000) {
    cleanContent = cleanContent.substring(0, 1000) + '...';
  }

  // Apply prompt injection sanitizer
  let sanitizedContent = sanitizeForPrompt(cleanContent);
  if (!sanitizedContent.trim()) {
    sanitizedContent = "...";
  }

  // 5. Always log messages to channel context for general room awareness
  updateChannelLog(message, sanitizedContent);

  // 6. Handle Message Cooldown (supports custom Admin slowmode)
  const now = Date.now();
  let cooldownAmount = 3000;
  if (adminSlowmode.has(guildId)) {
    const slowmodeInfo = adminSlowmode.get(guildId);
    if (now < slowmodeInfo.expiresAt) {
      cooldownAmount = slowmodeInfo.cooldownMs;
    } else {
      adminSlowmode.delete(guildId);
    }
  }

  const userCooldownKey = `${guildId}-${userId}`;
  if (cooldowns.has(userCooldownKey)) {
    const expirationTime = cooldowns.get(userCooldownKey) + cooldownAmount;
    if (now < expirationTime) {
      return;
    }
  }
  cooldowns.set(userCooldownKey, now);

  // 7. Check if bot is mentioned, replied to, or chaos mode triggers
  const isMentioned = message.mentions.has(client.user) && !message.mentions.everyone;
  
  let isReplyToBot = false;
  let replyToMessage = null;
  if (message.reference && message.reference.messageId) {
    try {
      const refMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (refMessage.author.id === client.user.id) {
        isReplyToBot = true;
        replyToMessage = refMessage;
      }
    } catch (err) {
      // ignore
    }
  }

  // Check Chaos Mode (15% chance of response on any message when active)
  let isChaosTrigger = false;
  if (chaosMode.has(guildId)) {
    const expiresAt = chaosMode.get(guildId);
    if (now < expiresAt) {
      isChaosTrigger = Math.random() < 0.15;
    } else {
      chaosMode.delete(guildId);
    }
  }

  // If not mentioned, not a reply, and not chaos triggered, do not reply
  if (!isMentioned && !isReplyToBot && !isChaosTrigger) {
    return;
  }

  // 7b. Trace Thread Context for Reply-Based Joins
  let threadContext = null;
  if (isReplyToBot && replyToMessage) {
    try {
      let originalUserId = null;
      if (replyToMessage.reference && replyToMessage.reference.messageId) {
        const origMessage = await message.channel.messages.fetch(replyToMessage.reference.messageId);
        originalUserId = origMessage.author.id;
      }
      
      if (!originalUserId && replyToMessage.mentions && replyToMessage.mentions.users.size > 0) {
        const mentionedUser = replyToMessage.mentions.users.filter(u => u.id !== client.user.id).first();
        if (mentionedUser) {
          originalUserId = mentionedUser.id;
        }
      }

      if (!originalUserId) {
        const mentionMatch = replyToMessage.content.match(/<@!?(\d+)>/);
        if (mentionMatch) {
          originalUserId = mentionMatch[1];
        }
      }

      if (originalUserId && originalUserId !== userId) {
        const isNsfw = await db.getNsfwAccess(guildId, userId);
        const originalUserKey = `${message.channel.id}-${originalUserId}`;
        const history = isNsfw ? nsfwConversations.get(originalUserKey) : userConversations.get(originalUserKey);
        
        if (history && history.length > 0) {
          let historyStr = "";
          history.forEach(m => {
            const roleStr = m.role === 'assistant' ? 'lilgooner' : (m.name || 'user');
            historyStr += `\n- ${roleStr}: ${m.content}`;
          });
          threadContext = `[THREAD CONTEXT: You were originally having a conversation with another user (ID: ${originalUserId}) in this thread. Here is that conversation history:${historyStr}\nNow, a 3rd person (${username}, ID: ${userId}) has replied to your message, jumping into the conversation. Keep the context of what you were talking about with the original user in mind, but address ${username} and reply to their message directly. Do not start a completely new context if it fits the flow.]`;
        }
      }
    } catch (err) {
      console.error('Error tracing thread context:', err);
    }
  }

  // 8. Crisis Guardrail: Check after mention/reply/chaos checks pass
  if (checkCrisisTriggers(cleanContent)) {
    await handleCrisisResponse(message);
    return;
  }

  // 9. Rate Limit check
  if (!checkGroqRateLimit()) {
    await message.reply('api is cooked fr 💀');
    return;
  }

  // Set typing status while processing with a human delay
  try {
    await message.channel.sendTyping();
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
  } catch (err) {
    console.warn('Could not send typing indicator:', err.message);
  }

  // Random reactions to feel alive (25% chance)
  if (Math.random() < 0.25) {
    const emojis = ['💀', '😭', '🔥', '🤓', '🤡', '🗿', '💅', '👀', '🥺', '🥱'];
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    try {
      await message.react(randomEmoji);
    } catch (e) {}
  }

  try {
    // 10. Get guild and user state
    const guildConfig = await db.getPersonalityConfig(guildId);
    
    // Apply temporary toxicity override if active
    if (tempToxicitySettings.has(guildId)) {
      const tempConfig = tempToxicitySettings.get(guildId);
      if (now < tempConfig.expires) {
        guildConfig.toxicity_level = tempConfig.override;
      } else {
        tempToxicitySettings.delete(guildId);
      }
    }

    const senderStatus = await db.getBanishBlessStatus(userId);
    const isOwner = userId === OWNER_DISCORD_ID;

    // Fetch user nickname from DB
    const nickname = await db.getNickname(userId);

    // Check puppet state
    let isPuppeted = false;
    const puppetKey = `${guildId}-${userId}`;
    if (puppetedUsers.has(puppetKey)) {
      const expiresAt = puppetedUsers.get(puppetKey);
      if (now < expiresAt) {
        isPuppeted = true;
      } else {
        puppetedUsers.delete(puppetKey);
      }
    }

    // Check brainrot state
    const isBrainrot = brainrotMode.has(guildId) && brainrotMode.get(guildId);

    // Check nsfw state (via DB)
    const isNsfw = await db.getNsfwAccess(guildId, userId);

    // Check server mood
    const serverMood = await db.getServerMood(guildId);

    let replyText = '';

    const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);

    if (isNsfw) {
      // NSFW OpenRouter mode
      updateUserConversationNsfw(message.channel.id, userId, 'user', sanitizedContent, username);

      const userConvKey = `${message.channel.id}-${userId}`;
      const userHistory = nsfwConversations.get(userConvKey) || [];

      const formattedMessages = userHistory.map((msg) => {
        return {
          role: msg.role,
          name: msg.name,
          content: msg.content
        };
      });

      // Inject daily greeting right before the last message
      const todayStr = new Date().toISOString().split('T')[0];
      const dailyGreetingKey = `${guildId}-${userId}`;
      let dailyGreetingNote = '';
      if (!dailyGreetings.has(dailyGreetingKey) || dailyGreetings.get(dailyGreetingKey) !== todayStr) {
        dailyGreetings.set(dailyGreetingKey, todayStr);
        dailyGreetingNote = `[System Notification: This is your first interaction with user ${username} today. Greet them with a randomized Gen-Z greeting/roast in your response.]`;
      }

      if (dailyGreetingNote && formattedMessages.length > 0) {
        formattedMessages.splice(formattedMessages.length - 1, 0, {
          role: 'system',
          content: dailyGreetingNote
        });
      }

      // Prepend room context
      const chanHistory = channelLogs.get(message.channel.id) || [];
      let roomContextStr = "[CHANNEL ROOM CONTEXT (recent messages in this channel from everyone to give you room awareness):";
      chanHistory.forEach(m => {
        const roleStr = m.role === 'assistant' ? 'lilgooner' : (m.name || 'user');
        roomContextStr += `\n- ${roleStr}: ${m.content}`;
      });
      roomContextStr += "\nUse this room context only for general awareness. Address the user specifically and reply using your 1-on-1 history below.]";

      if (threadContext) {
        formattedMessages.unshift({
          role: 'system',
          content: threadContext
        });
      }
      formattedMessages.unshift({
        role: 'system',
        content: roomContextStr
      });

      // Query OpenRouter (No tools in NSFW mode)
      const orResponse = await openrouter.queryOpenRouter(
        formattedMessages,
        username,
        userId,
        guildConfig,
        nickname,
        senderStatus,
        serverMood,
        isPrincess
      );

      replyText = orResponse.content || '';

      if (replyText.length > 800) {
        replyText = replyText.substring(0, 797) + '...';
      }

      if (replyText.trim().length > 0) {
        let sentMsg;
        try {
          sentMsg = await message.reply(replyText);
        } catch (err) {
          try {
            sentMsg = await message.channel.send(replyText);
          } catch (sendErr) {
            console.error('Failed to fallback send message:', sendErr);
          }
        }
        if (sentMsg) {
          updateChannelLog(sentMsg, replyText);
          updateUserConversationNsfw(message.channel.id, userId, 'assistant', replyText);
        }
      }
    } else {
      // Normal Groq mode
      updateUserConversation(message.channel.id, userId, 'user', sanitizedContent, username);

      const userConvKey = `${message.channel.id}-${userId}`;
      const userHistory = userConversations.get(userConvKey) || [];

      const formattedMessages = userHistory.map((msg) => {
        return {
          role: msg.role,
          name: msg.name,
          content: msg.content
        };
      });

      const todayStr = new Date().toISOString().split('T')[0];
      const dailyGreetingKey = `${guildId}-${userId}`;
      let dailyGreetingNote = '';
      if (!dailyGreetings.has(dailyGreetingKey) || dailyGreetings.get(dailyGreetingKey) !== todayStr) {
        dailyGreetings.set(dailyGreetingKey, todayStr);
        dailyGreetingNote = `[System Notification: This is your first interaction with user ${username} today. Greet them with a randomized Gen-Z greeting/roast in your response.]`;
      }

      if (dailyGreetingNote && formattedMessages.length > 0) {
        formattedMessages.splice(formattedMessages.length - 1, 0, {
          role: 'system',
          content: dailyGreetingNote
        });
      }

      // Prepend room context
      const chanHistory = channelLogs.get(message.channel.id) || [];
      let roomContextStr = "[CHANNEL ROOM CONTEXT (recent messages in this channel from everyone to give you room awareness):";
      chanHistory.forEach(m => {
        const roleStr = m.role === 'assistant' ? 'lilgooner' : (m.name || 'user');
        roomContextStr += `\n- ${roleStr}: ${m.content}`;
      });
      roomContextStr += "\nUse this room context only for general awareness. Address the user specifically and reply using your 1-on-1 history below.]";

      if (threadContext) {
        formattedMessages.unshift({
          role: 'system',
          content: threadContext
        });
      }
      formattedMessages.unshift({
        role: 'system',
        content: roomContextStr
      });

      const useTools = detectToolKeywords(sanitizedContent);

      let groqResponse = await groq.queryGroq(
        formattedMessages,
        isOwner,
        guildConfig,
        username,
        userId,
        senderStatus,
        useTools,
        nickname,
        isPuppeted,
        isBrainrot,
        serverMood,
        isPrincess
      );

      // Handle Tool Calls
      if (groqResponse.tool_calls && groqResponse.tool_calls.length > 0) {
        formattedMessages.push(groqResponse);

        for (const toolCall of groqResponse.tool_calls) {
          const toolName = toolCall.function.name;
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            console.error('Failed to parse tool arguments:', e);
          }

          const ownerOnlyTools = [
            'ping_and_say', 'toggle_setting', 'impersonate_owner', 
            'banish_user', 'bless_user', 'server_vibe_check'
          ];

          if (ownerOnlyTools.includes(toolName) && !isOwner) {
            formattedMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolName,
              content: `Error: Refused. User ${username} is not the owner.`
            });
            continue;
          }

          console.log(`Executing tool: ${toolName} with args:`, args);
          try {
            const toolResult = await executeTool(toolName, args, message);
            formattedMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolName,
              content: String(toolResult)
            });

            if (toolName === 'impersonate_owner') {
              return;
            }
          } catch (err) {
            console.error(`Error executing tool ${toolName}:`, err);
            formattedMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolName,
              content: `Error: Something went wrong internally.`
            });
          }
        }

        groqResponse = await groq.queryGroq(
          formattedMessages,
          isOwner,
          guildConfig,
          username,
          userId,
          senderStatus,
          false,
          nickname,
          isPuppeted,
          isBrainrot,
          serverMood,
          isPrincess
        );
      }

      replyText = groqResponse.content || '';

      if (replyText.length > 500) {
        replyText = replyText.substring(0, 497) + '...';
      }

      if (replyText.trim().length > 0) {
        let sentMsg;
        try {
          sentMsg = await message.reply(replyText);
        } catch (err) {
          try {
            sentMsg = await message.channel.send(replyText);
          } catch (sendErr) {
            console.error('Failed to fallback send message:', sendErr);
          }
        }
        if (sentMsg) {
          updateChannelLog(sentMsg, replyText);
          updateUserConversation(message.channel.id, userId, 'assistant', replyText);
        }
      }
    }

  } catch (error) {
    console.error('Error generating response:', error);
    try {
      await message.reply('api is cooked fr 💀');
    } catch (replyErr) {
      try {
        await message.channel.send('api is cooked fr 💀');
      } catch (sendErr) {
        console.error('Failed to send error message:', sendErr);
      }
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, guildId } = interaction;
  const isOwner = user.id === OWNER_DISCORD_ID;

  // Check Admin Permissions (comment 1)
  const isAdmin = isOwner || 
    (interaction.member && 
     (interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) || 
      interaction.member.permissions.has(PermissionFlagsBits.Administrator)));



  if (commandName === 'admin' && !isAdmin) {
    return interaction.reply({
      content: "Refused: You need to be an admin to use admin commands 💀",
      ephemeral: true
    });
  }

  try {
    // ----------------------------------------------------
    // INFO Command (Role-based details, comment 1)
    // ----------------------------------------------------
    if (commandName === 'info') {
      let infoMsg = "";
      if (isOwner) {
        infoMsg = `👑 **LILGOONER OWNER INFO** (Prefix normal messages with !owner)\n` +
          `- **!owner princess [on/off]**: Toggle ultra cute princess mode server-wide.\n` +
          `- **!owner banish/unbanish [user] [duration_mins]**: Roast target hard.\n` +
          `- **!owner bless/unbless [user] [duration_mins]**: Glaze target.\n` +
          `- **!owner config [setting] [value]**: Adjust personality (toxicity_level, slang_intensity, emoji_frequency, reset_all).\n` +
          `- **!owner ghost/unghost [user] [duration_mins]**: Make bot ignore user completely.\n` +
          `- **!owner puppet/unpuppet [user] [duration_mins]**: Make bot agree with user sarcastically.\n` +
          `- **!owner chaos [active: true/false] [duration_mins]**: Toggle random roasts.\n` +
          `- **!owner nickname [user] [name/clear]**: Set custom name for user.\n` +
          `- **!owner brainrot [active: true/false]**: Toggle bot-wide brainrot speak mode.\n` +
          `- **!owner nsfw [user] [duration_mins]**: Enable OpenRouter NSFW roleplay.\n` +
          `- **!owner unsfw [user]**: Disable NSFW roleplay.\n` +
          `- **!owner announce [message]**: Make owner announcement.\n` +
          `- **!owner impersonate [content]**: Speak as bot.\n` +
          `- **!owner vibecheck**: Trigger server vibecheck.\n\n` +
          `⚙️ **ADMIN COMMANDS**:\n` +
          `- **/admin status**: View configurations and active timers.\n` +
          `- **/admin warn [user] [reason]**: Public warning with aura penalty.\n` +
          `- **/admin lockdown [duration_mins]**: Lock bot to admin-only temporarily.\n` +
          `- **/admin poll [question]**: Quick 60-second reaction poll.\n` +
          `- **/admin mute/unmute [user]**: Block user from getting replies.\n` +
          `- **/admin slowmode [seconds]**: Set bot cooldown.\n` +
          `- **/admin vibecheck**: Start vibe check.\n\n` +
          `🟢 **MEMBER COMMANDS**:\n` +
          `- **/roastme**, **/fortune**, **/sus [user]**, **/battle [user]**, **/fakequote [user]**, **/dare**, **/confess**, **/ratio**`;
      } else if (isAdmin) {
        infoMsg = `⚙️ **LILGOONER ADMIN INFO**\n` +
          `- **/admin status**: View configurations and active timers.\n` +
          `- **/admin warn [user] [reason]**: Public warning with aura penalty.\n` +
          `- **/admin lockdown [duration_mins]**: Lock bot to admin-only temporarily.\n` +
          `- **/admin poll [question]**: Quick 60-second reaction poll.\n` +
          `- **/admin mute/unmute [user]**: Block user from getting replies.\n` +
          `- **/admin slowmode [seconds]**: Set bot cooldown.\n` +
          `- **/admin vibecheck**: Start vibe check.\n\n` +
          `🟢 **MEMBER COMMANDS**:\n` +
          `- **/roastme**, **/fortune**, **/sus [user]**, **/battle [user]**, **/fakequote [user]**, **/dare**, **/confess**, **/ratio**`;
      } else {
        infoMsg = `🟢 **LILGOONER MEMBER COMMANDS**\n` +
          `- **/roastme**: Ask the bot to roast you.\n` +
          `- **/fortune**: Get a Gen-Z brainrot prediction.\n` +
          `- **/sus [user]**: Rate sus level of a user.\n` +
          `- **/battle [user]**: Start a mock rap battle with someone.\n` +
          `- **/fakequote [user]**: Generate a fake quote attributed to a user.\n` +
          `- **/dare**: Get a Gen-Z brainrot dare challenge.\n` +
          `- **/confess**: Submit an anonymous confession.\n` +
          `- **/ratio**: Attempt to ratio someone.`;
      }

      return interaction.reply({ content: infoMsg, ephemeral: true });
    }

    // ----------------------------------------------------
    // MEMBER Commands
    // ----------------------------------------------------
    if (commandName === 'roastme') {
      await interaction.deferReply();
      const channelMsgs = await interaction.channel.messages.fetch({ limit: 50 });
      const targetMsgs = channelMsgs.filter(m => m.author.id === user.id && !m.author.bot).toJSON().slice(0, 10).map(m => m.content).filter(Boolean);
      const userAura = await db.getAuraPoints(user.id);
      const msgsContext = targetMsgs.length > 0 ? targetMsgs.join(' | ') : "No recent messages";

      const promptText = `Generate a savage, hilarious, and short (1 sentence) roast targeting the user ${user.username} (Aura points: ${userAura}). 
      Use their recent messages in this channel to make the roast personal and reference what they said: "${msgsContext}". Make it Gen-Z styled and cringe/sarcastic.`;
      
      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        user.username,
        user.id,
        await db.getBanishBlessStatus(user.id),
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );
      return interaction.editReply(`<@${user.id}>: ${response.content}`);
    }

    if (commandName === 'fortune') {
      await interaction.deferReply();
      const categories = ['🎮 Gaming', '💀 Cursed', '💕 Rizz', '🧠 Sigma'];
      const cat = categories[Math.floor(Math.random() * categories.length)];
      const promptText = `Generate a funny, cringe, slang-filled Gen-Z fortune cookie prediction (1 sentence) for user ${user.username} based on the category "${cat}".`;
      
      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        user.username,
        user.id,
        await db.getBanishBlessStatus(user.id),
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );
      return interaction.editReply(`🔮 **Fortune Category**: **${cat}**\n🔮 **Prediction for <@${user.id}>**: ${response.content}`);
    }

    if (commandName === 'sus') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');
      
      const channelMsgs = await interaction.channel.messages.fetch({ limit: 100 });
      const targetMsgs = channelMsgs
        .filter(m => m.author.id === targetUser.id && !m.author.bot)
        .toJSON()
        .slice(0, 15);
      const targetAura = await db.getAuraPoints(targetUser.id);
      
      let pct = 50;
      pct += Math.max(-30, Math.min(30, Math.floor((500 - targetAura) / 10)));
      pct += targetMsgs.length * 2;
      pct += Math.floor(Math.random() * 20) - 10;
      pct = Math.max(0, Math.min(100, pct));
      
      const msgContents = targetMsgs.map(m => m.content).filter(Boolean);
      const msgsContext = msgContents.length > 0 
        ? `Here are some of their recent messages in this channel to use as real evidence:\n${msgContents.map((m, idx) => `[${idx+1}]: "${m}"`).join('\n')}`
        : "They have no recent messages in this channel.";

      const promptText = `Generate a short (1 sentence) hilarious explanation of why user ${targetUser.username} was rated ${pct}% sus (suspicious/imposter) using the following real evidence: ${msgsContext}. Make it extremely Gen-Z and sarcastic, referring directly to things they said if possible.`;
      
      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        targetUser.username,
        targetUser.id,
        await db.getBanishBlessStatus(targetUser.id),
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );

      let auraFeedback = "";
      if (pct < 30) {
        await db.adjustAuraPoints(targetUser.id, 10);
        auraFeedback = "\n😇 *Awarded +10 aura points for being low sus!*";
      } else if (pct > 70) {
        await db.adjustAuraPoints(targetUser.id, -10);
        auraFeedback = "\n😡 *Deducted 10 aura points for high sus behavior!*";
      }

      return interaction.editReply(`🔎 **Sus Meter for <@${targetUser.id}>**: **${pct}%**\n` +
        `🚨 **Evidence**: *Real message history and aura levels checked.*\n` +
        `💬 **Verdict**: "${response.content}"${auraFeedback}`);
    }

    if (commandName === 'battle') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');
      if (targetUser.id === user.id) {
        return interaction.editReply("you can't roast battle yourself NPC 💀");
      }
      
      const channelMsgs = await interaction.channel.messages.fetch({ limit: 100 });
      const userMsgs = channelMsgs.filter(m => m.author.id === user.id && !m.author.bot).toJSON().slice(0, 10).map(m => m.content).filter(Boolean);
      const targetMsgs = channelMsgs.filter(m => m.author.id === targetUser.id && !m.author.bot).toJSON().slice(0, 10).map(m => m.content).filter(Boolean);
      const userAura = await db.getAuraPoints(user.id);
      const targetAura = await db.getAuraPoints(targetUser.id);
      
      const userContext = userMsgs.length > 0 ? userMsgs.join(' | ') : "No recent messages";
      const targetContext = targetMsgs.length > 0 ? targetMsgs.join(' | ') : "No recent messages";

      const promptText = `Generate a quick 3-round roast battle between ${user.username} (Aura: ${userAura}) and ${targetUser.username} (Aura: ${targetAura}). 
      Use their actual recent messages to personalize the roasts:
      - ${user.username} recent messages: ${userContext}
      - ${targetUser.username} recent messages: ${targetContext}
      For each round, write a 1-line roast from each person (6 lines total). Format it as:
      Round 1: [user1 roast], [user2 roast]
      Round 2: [user1 roast], [user2 roast]
      Round 3: [user1 roast], [user2 roast]
      Keep it extremely Gen-Z, funny, and referencing their actual speech pattern or content.`;

      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        user.username,
        user.id,
        await db.getBanishBlessStatus(user.id),
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );

      const auraDiff = userAura - targetAura;
      const baseChance = 0.5;
      const userWinChance = Math.max(0.35, Math.min(0.65, baseChance + (auraDiff / 100) * 0.05));
      const winner = Math.random() < userWinChance ? user : targetUser;
      const points = Math.floor(Math.random() * 50) + 10;
      await db.adjustAuraPoints(winner.id, points);

      return interaction.editReply(
        `🎤 **RAP BATTLE: <@${user.id}> vs <@${targetUser.id}>**\n\n` +
        `${response.content}\n\n` +
        `🏆 **WINNER**: <@${winner.id}> (+${points} aura points! 🥳)`
      );
    }

    if (commandName === 'fakequote') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');
      
      const channelMsgs = await interaction.channel.messages.fetch({ limit: 50 });
      const targetMsgs = channelMsgs.filter(m => m.author.id === targetUser.id && !m.author.bot).toJSON().slice(0, 10).map(m => m.content).filter(Boolean);
      const msgsContext = targetMsgs.length > 0 ? targetMsgs.join(' | ') : "No recent messages";

      const promptText = `Generate a fake, absurd quote attributed to the user ${targetUser.username}. The quote should mimic their speech pattern, tone, and vocabulary based on their recent messages: "${msgsContext}". The quote can be deep, inspirational, brainrot or ridiculous Gen-Z wisdom (1 sentence). Do not quote them verbatim, make up something fake.`;

      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        targetUser.username,
        targetUser.id,
        await db.getBanishBlessStatus(targetUser.id),
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );
      return interaction.editReply(
        `> ✍️ *"${response.content}"*\n` +
        `> \n` +
        `> — **<@${targetUser.id}>**, ${new Date().getFullYear()} 🗿`
      );
    }

    if (commandName === 'dare') {
      await interaction.deferReply();
      const promptText = `Generate a highly cringe, funny, and safe Gen-Z brainrot dare challenge (1 sentence). Examples: 'Go to a public channel and say you look like a skibidi toilet', 'message a random person and tell them they have zero aura points'. Keep it extremely funny and slang-filled.`;
      
      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        user.username,
        user.id,
        await db.getBanishBlessStatus(user.id),
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );
      return interaction.editReply(`🎲 **Dare for <@${user.id}>**: ${response.content}`);
    }

    if (commandName === 'confess') {
      const confession = interaction.options.getString('confession');
      await interaction.reply({ content: 'sending confession anonymously...', ephemeral: true });
      
      const promptText = `Generate a funny, highly judgmental, and sarcastic Gen-Z commentary (1-2 sentences) on this anonymous confession: "${confession}"`;
      
      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        'anonymous',
        'anonymous_id',
        null,
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );
      
      return interaction.channel.send(`🤫 **Anonymous Confession**: "${confession}"\n💬 **lilgooner's verdict**: ${response.content}`);
    }

    if (commandName === 'ratio') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');
      if (targetUser.id === user.id) {
        return interaction.editReply("you can't ratio yourself, that's an automatic L 💀");
      }
      
      const channelMsgs = await interaction.channel.messages.fetch({ limit: 50 });
      const selfCount = channelMsgs.filter(m => m.author.id === user.id).size;
      const targetCount = channelMsgs.filter(m => m.author.id === targetUser.id).size;
      
      const selfAura = await db.getAuraPoints(user.id);
      const targetAura = await db.getAuraPoints(targetUser.id);
      
      const selfWeight = selfCount + (selfAura / 20);
      const targetWeight = targetCount + (targetAura / 20);
      
      const totalWeight = selfWeight + targetWeight || 1;
      let pctSelf = Math.floor((selfWeight / totalWeight) * 100);
      pctSelf = Math.max(5, Math.min(95, pctSelf));
      const pctTarget = 100 - pctSelf;
      
      const promptText = `Generate a 1-sentence hilarious explanation of why <@${user.id}> successfully ratioed <@${targetUser.id}> (scores: ${pctSelf} vs ${pctTarget}) or why they failed miserably. Make it extremely Gen-Z and slang-heavy.`;
      
      const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
      const response = await groq.queryGroq(
        [{ role: 'user', content: promptText }],
        false,
        await db.getPersonalityConfig(guildId),
        user.username,
        user.id,
        await db.getBanishBlessStatus(user.id),
        false,
        null,
        false,
        false,
        null,
        isPrincess
      );
      
      const winner = pctSelf > pctTarget ? `<@${user.id}>` : `<@${targetUser.id}>`;
      const auraChange = Math.floor(Math.random() * 100) + 10;
      const winnerId = pctSelf > pctTarget ? user.id : targetUser.id;
      await db.adjustAuraPoints(winnerId, auraChange);
      
      return interaction.editReply(`📈 **Ratio Battle**: <@${user.id}> vs <@${targetUser.id}>\n` +
        `- **<@${user.id}>**: ${pctSelf}%\n` +
        `- **<@${targetUser.id}>**: ${pctTarget}%\n\n` +
        `🏆 Winner: ${winner} (+${auraChange} aura points!)\n` +
        `💬 ${response.content}`);
    }

    // ----------------------------------------------------
    // ADMIN Commands
    // ----------------------------------------------------
    if (commandName === 'admin') {
      const subcommand = interaction.options.getSubcommand();
      
      switch (subcommand) {
        case 'status': {
          const config = await db.getPersonalityConfig(guildId);
          
          let activeEffects = [];
          
          // Check slowmode
          if (adminSlowmode.has(guildId)) {
            const sm = adminSlowmode.get(guildId);
            if (Date.now() < sm.expiresAt) {
              activeEffects.push(`- **Slowmode**: ${sm.cooldownMs / 1000}s cooldown (Expires in ${Math.round((sm.expiresAt - Date.now()) / 60000)}m)`);
            }
          }
          
          // Check Princess mode
          const princessActive = princessMode.has(guildId) && princessMode.get(guildId);
          activeEffects.push(`- **Princess Mode**: ${princessActive ? 'Active 🎀' : 'Inactive'}`);

          // Check Lockdown mode
          if (lockdownMode.has(guildId)) {
            const expires = lockdownMode.get(guildId);
            if (Date.now() < expires) {
              activeEffects.push(`- **Lockdown Mode**: Active (Expires in ${Math.round((expires - Date.now()) / 60000)}m)`);
            }
          }

          // Check brainrot mode
          if (brainrotMode.has(guildId) && brainrotMode.get(guildId)) {
            activeEffects.push(`- **Brainrot Mode**: Active bot-wide`);
          }

          // Check chaos mode
          if (chaosMode.has(guildId)) {
            const expires = chaosMode.get(guildId);
            if (Date.now() < expires) {
              activeEffects.push(`- **Chaos Mode**: Active (Expires in ${Math.round((expires - Date.now()) / 60000)}m)`);
            }
          }

          // Check server mood
          const serverMood = await db.getServerMood(guildId);
          if (serverMood) {
            activeEffects.push(`- **Server Mood**: ${serverMood.toUpperCase()}`);
          }

          // Check muted users
          for (const [key, expiresAt] of mutedUsers.entries()) {
            if (key.startsWith(`${guildId}-`) && Date.now() < expiresAt) {
              const uId = key.split('-')[1];
              activeEffects.push(`- **Muted**: <@${uId}> (Expires in ${Math.round((expiresAt - Date.now()) / 60000)}m)`);
            }
          }

          // Check ghosted users
          for (const [key, expiresAt] of ghostedUsers.entries()) {
            if (key.startsWith(`${guildId}-`) && Date.now() < expiresAt) {
              const uId = key.split('-')[1];
              activeEffects.push(`- **Ghosted**: <@${uId}> (Expires in ${Math.round((expiresAt - Date.now()) / 60000)}m)`);
            }
          }

          // Check puppeted users
          for (const [key, expiresAt] of puppetedUsers.entries()) {
            if (key.startsWith(`${guildId}-`) && Date.now() < expiresAt) {
              const uId = key.split('-')[1];
              activeEffects.push(`- **Puppeted**: <@${uId}> (Expires in ${Math.round((expiresAt - Date.now()) / 60000)}m)`);
            }
          }

          // Check NSFW users from Database
          const nsfwAccessList = await db.getAllNsfwAccess(guildId);
          for (const item of nsfwAccessList) {
            const remaining = item.expires_at === null ? 'Indefinitely' : `Expires in ${Math.round((new Date(item.expires_at) - Date.now()) / 60000)}m`;
            activeEffects.push(`- **NSFW**: <@${item.user_id}> (${remaining})`);
          }

          const statusMsg = `📊 **LILGOONER SERVER STATUS & CONFIG**\n` +
            `- **Toxicity Level**: ${config.toxicity_level}/10\n` +
            `- **Slang Intensity**: ${config.slang_intensity}/10\n` +
            `- **Emoji Frequency**: ${config.emoji_frequency}/10\n` +
            `- **Banned Phrases**: ${config.banned_phrases || '[]'}\n\n` +
            `⚡ **Active Effects**:\n${activeEffects.length > 0 ? activeEffects.join('\n') : 'None'}`;

          return interaction.reply({ content: statusMsg, ephemeral: false });
        }

        case 'vibecheck': {
          const channel = interaction.channel;
          const vMsg = await channel.send("🚨 **SERVER VIBE CHECK TIME** 🚨\nReact to this message with any emoji in the next 30 seconds to get your aura rated and roasted! Do it or you're mid 💀");
          const filter = (reaction, user) => !user.bot;
          const collector = vMsg.createReactionCollector({ filter, time: 30000 });
          const reactedUsers = new Set();

          collector.on('collect', async (reaction, user) => {
            if (reactedUsers.has(user.id)) return;
            reactedUsers.add(user.id);
            
            const userAura = await db.getAuraPoints(user.id);
            const promptText = `Generate a 1-sentence savage roast or funny compliment for user ${user.username} (Aura points: ${userAura}) who reacted to our server vibe check.`;
            try {
              const isPrincess = princessMode.has(guildId) && princessMode.get(guildId);
              const response = await groq.queryGroq(
                [{ role: 'user', content: promptText }],
                false,
                await db.getPersonalityConfig(guildId),
                user.username,
                user.id,
                await db.getBanishBlessStatus(user.id),
                false,
                null,
                false,
                false,
                null,
                isPrincess
              );
              await vMsg.reply(`<@${user.id}>: ${response.content}`);
            } catch (err) {
              console.error(err);
            }
          });

          collector.on('end', () => {
            vMsg.reply("vibe check closed. thanks for yapping 💀");
          });

          return interaction.reply({ content: "started server vibe check!", ephemeral: true });
        }

        case 'mute': {
          const targetUser = interaction.options.getUser('user');
          const duration = interaction.options.getInteger('duration') || 60;
          mutedUsers.set(`${guildId}-${targetUser.id}`, Date.now() + duration * 60 * 1000);
          return interaction.reply({
            content: `muted <@${targetUser.id}> for the next ${duration} minutes. they won't get any replies 🤫`,
            ephemeral: true
          });
        }

        case 'unmute': {
          const targetUser = interaction.options.getUser('user');
          mutedUsers.delete(`${guildId}-${targetUser.id}`);
          return interaction.reply({
            content: `unmuted <@${targetUser.id}>. they can yap again 🙄`,
            ephemeral: true
          });
        }

        case 'slowmode': {
          const seconds = interaction.options.getInteger('seconds');
          const duration = interaction.options.getInteger('duration') || 60;
          if (seconds <= 0) {
            adminSlowmode.delete(guildId);
            return interaction.reply({ content: "bot slowmode disabled. normal speed restored.", ephemeral: true });
          }
          adminSlowmode.set(guildId, {
            cooldownMs: seconds * 1000,
            expiresAt: Date.now() + duration * 60 * 1000
          });
          return interaction.reply({
            content: `slowmode set to ${seconds} seconds between bot responses for the next ${duration} minutes.`,
            ephemeral: true
          });
        }

        case 'warn': {
          const targetUser = interaction.options.getUser('user');
          const reason = interaction.options.getString('reason');
          
          const newAura = await db.adjustAuraPoints(targetUser.id, -50);
          
          await interaction.channel.send(`⚠️ **WARNING** ⚠️ <@${targetUser.id}> has been officially warned by an admin.\nReason: "${reason}". Keep it together or you're getting muted. 💀`);
          
          return interaction.reply({
            content: `Warned <@${targetUser.id}> and deducted 50 aura points (new total: ${newAura}).`,
            ephemeral: true
          });
        }

        case 'lockdown': {
          const duration = interaction.options.getInteger('duration') || 10;
          const expiresAt = Date.now() + duration * 60 * 1000;
          lockdownMode.set(guildId, expiresAt);
          
          await interaction.channel.send(`🔒 **LOCKDOWN ACTIVE** 🔒 Bot is in lockdown mode for the next ${duration} minutes. Only admins can interact.`);
          
          return interaction.reply({
            content: `Bot lockdown enabled for ${duration} minutes.`,
            ephemeral: true
          });
        }

        case 'poll': {
          const question = interaction.options.getString('question');
          
          await interaction.reply({
            content: `Creating poll for: "${question}"`,
            ephemeral: true
          });

          const pollMsg = await interaction.channel.send(
            `📊 **POLL**: "${question}"\n` +
            `✅ Yes | ❌ No\n` +
            `Voting closes in 60 seconds!`
          );

          try {
            await pollMsg.react('✅');
            await pollMsg.react('❌');
          } catch (e) {
            console.error('Failed to react to poll message:', e);
          }

          setTimeout(async () => {
            try {
              const fetchedMsg = await interaction.channel.messages.fetch(pollMsg.id);
              let yesVotes = 0;
              let noVotes = 0;

              const yesReaction = fetchedMsg.reactions.cache.get('✅');
              const noReaction = fetchedMsg.reactions.cache.get('❌');

              if (yesReaction) yesVotes = Math.max(0, yesReaction.count - 1);
              if (noReaction) noVotes = Math.max(0, noReaction.count - 1);

              let winnerText = 'Tie 🤝';
              if (yesVotes > noVotes) {
                winnerText = 'Yes ✅';
              } else if (noVotes > yesVotes) {
                winnerText = 'No ❌';
              }

              await interaction.channel.send(
                `📊 **POLL RESULTS**: "${question}"\n` +
                `✅ Yes: ${yesVotes} votes | ❌ No: ${noVotes} votes\n` +
                `🏆 Winner: **${winnerText}**`
              );
            } catch (err) {
              console.error('Error ending poll:', err);
            }
          }, 60000);

          return;
        }
      }
    }


  } catch (error) {
    console.error('Interaction error:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'interaction execution failed 💀' });
      } else {
        await interaction.reply({ content: 'interaction execution failed 💀', ephemeral: true });
      }
    } catch (err) {}
  }
});

// Start bot
start();
