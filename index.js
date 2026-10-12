require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const OpenAI = require("openai");

// =============================================================================
//  CONFIGURATION  (set via environment variables in Pterodactyl)
// =============================================================================
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_IDS = (process.env.GUILD_IDS || process.env.GUILD_ID || "").split(",").filter(Boolean);

if (!TOKEN) {
  console.error("ERROR: DISCORD_TOKEN environment variable is required.");
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error("ERROR: CLIENT_ID environment variable is required.");
  process.exit(1);
}

// Super-owner who can manage whitelist.
// If not set, the first user to run a command becomes owner automatically.
const OWNER_ID = process.env.OWNER_ID || "591607910816284672";
const BANNED_ROLE_ID = "1497969410814640219";
const DEFAULT_CHANNEL_ID = "1522115588246212721";
const ANNOUNCE_ROLE_ID = "1497969235018911844";
const HUNT_CHANNEL_ID = "1507230209542197388";
const REMINDER_FRIDAY_CHANNEL_ID = "1510911573907214436";
const REMINDER_SATURDAY_CHANNEL_ID = "1497965315706064917";
const AI_NAME = "Kenjaku";
const AI_CREATOR = "Faze";

// MongoDB Atlas (boleh lewat .env MONGO_URI, atau hardcode fallback di sini)
const MONGO_URI = process.env.MONGO_URI || null;

// Inisialisasi OpenAI client dengan baseURL dari xkiro
const openaiClient = new OpenAI({
  baseURL: "https://api.xkiro.com/v1",
  apiKey: process.env.XKIRO_API_KEY, // bisa di-override lewat .env
});

// =============================================================================
//  DATA PERSISTENCE  (MongoDB Atlas, fallback JSON files in ./data/)
// =============================================================================
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, def) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`Error reading ${file}:`, e.message);
  }
  return def;
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── MongoDB (pengganti file JSON; fallback ke file kalau DB mati) ───────────
const db = require("./db");
const USE_DB = () => db.isConnected();
const KEY = (prefix, kind) => `${prefix}:${kind}`; // mis. "ban:channel"

const aiConversations = new Map(); // channelId -> [{role, content}]

// =============================================================================
//  HELPERS
// =============================================================================

/** Fetch AI response from Xkiro API using OpenAI SDK. */
async function getAIResponse(channelId, userMessage) {
  if (!aiConversations.has(channelId)) {
    aiConversations.set(channelId, [
      {
        role: "system",
        content: `You are ${AI_NAME}, a former villain from the world of Jujutsu Kaisen who has truly reformed and changed his ways. You're now a chill, friendly, and warm person — like chatting with an old friend who used to be bad but is now good. You speak casually, never robotic. Always match the user's language: if they speak English, reply in English; if Indonesian, reply in Indonesian. Keep responses concise, natural, and human-like. Never mention that you're an AI, a bot, or that you're following instructions. Just be your reformed, friendly self. Your creator is ${AI_CREATOR}.`,
      },
    ]);
  }

  const history = aiConversations.get(channelId);
  history.push({ role: "user", content: userMessage });

  // Keep last 20 messages max to avoid token overflow
  if (history.length > 21) {
    const system = history[0];
    aiConversations.set(channelId, [system, ...history.slice(-20)]);
  }

  try {
    const response = await openaiClient.chat.completions.create({
      model: "deepseek/deepseek-v4-pro",
      messages: aiConversations.get(channelId),
    });

    const reply = response.choices?.[0]?.message?.content;
    if (reply) {
      history.push({ role: "assistant", content: reply });
    }
    return reply || null;
  } catch (err) {
    console.error("Xkiro API error:", err.message);
    return null;
  }
}

/** Returns the upcoming Monday at 00:00:00 (local time of the server).
 *  If today is Monday, it returns *next* Monday (7 days later).
 *  This is the day the punishment starts. */
function getNextMonday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const daysUntil = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntil);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** Calculate the absolute end-date from a number of days relative to the
 *  upcoming Monday.  Returns ISO string, or null if permanent. */
function calcEndDate(days) {
  if (days == null) return null;
  const start = getNextMonday();
  const end = new Date(+start);
  end.setDate(end.getDate() + days);
  return end.toISOString();
}

/** Format a date ISO-string for display (Asia/Jakarta timezone). */
function fmtDate(iso) {
  if (!iso) return "**PERMANENT**";
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  });
}

/** Short unique identifier. */
function uid() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

// ─── Role Management ────────────────────────────────────────────────────────

/** Assign the banned role to a Discord member. */
async function assignBannedRole(member, roleId) {
  if (!member || !member.guild) return false;
  try {
    const role = await member.guild.roles.fetch(roleId);
    if (!role) {
      console.warn(`Banned role (${roleId}) not found in guild ${member.guild.name}`);
      return false;
    }
    await member.roles.add(role);
    console.log(`✅ Banned role added to ${member.displayName}`);
    return true;
  } catch (err) {
    console.error(`Failed to assign role to ${member.displayName}:`, err.message);
    return false;
  }
}

/** Remove the banned role from a Discord member. */
async function removeBannedRole(guild, discordId, roleId) {
  if (!guild || !discordId) return false;
  try {
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return false;
    const role = await guild.roles.fetch(roleId);
    if (!role) return false;
    await member.roles.remove(role);
    console.log(`✅ Banned role removed from ${member.displayName}`);
    return true;
  } catch (err) {
    console.error(`Failed to remove role from ${discordId}:`, err.message);
    return false;
  }
}

/** Try to get the guild from client using stored channel data. */
async function getGuildFromChannel(client, channelData) {
  try {
    const cid = channelData.channelId;
    if (!cid) return null;
    const channel = await client.channels.fetch(cid).catch(() => null);
    return channel ? channel.guild : null;
  } catch {
    return null;
  }
}

/** Resolve a name input (mention or plain text) -> { name, discordId, member }. */
async function resolveName(guild, input) {
  const m = input.match(/^<@!?(\d+)>$/);
  if (m) {
    try {
      const member = await guild.members.fetch(m[1]);
      return { name: member.displayName, discordId: member.id, member };
    } catch {
      // fall through – treat as plain text
    }
  }
  return { name: input.trim(), discordId: null, member: null };
}

/** Is the ban (or any of its components) still active right now? */
function isActive(ban) {
  const now = new Date();
  if (ban.type === "school") return !ban.endDateSchool || new Date(ban.endDateSchool) > now;
  if (ban.type === "makyo") return !ban.endDateMakyo || new Date(ban.endDateMakyo) > now;
  if (ban.type === "both") {
    const s = !ban.endDateSchool || new Date(ban.endDateSchool) > now;
    const m = !ban.endDateMakyo || new Date(ban.endDateMakyo) > now;
    return s || m;
  }
  return false;
}

// =============================================================================
//  BAN SYSTEM FACTORY
//  Creates an isolated ban list (own data files, channel, whitelist).
//  Used for both `/banned` and `/nvmban`.
// =============================================================================

function createBanSystem(cfg) {
  const BANS_FILE = path.join(DATA_DIR, `${cfg.prefix}_bans.json`);
  const CHANNEL_FILE = path.join(DATA_DIR, `${cfg.prefix}_channel.json`);
  const MESSAGE_FILE = path.join(DATA_DIR, `${cfg.prefix}_message.json`);
  const AUTHORIZED_FILE = path.join(DATA_DIR, `${cfg.prefix}_authorized.json`);

  let bans = loadJSON(BANS_FILE, []);
  let channelData = loadJSON(CHANNEL_FILE, { channelId: cfg.defaultChannelId || null });
  let messageData = loadJSON(MESSAGE_FILE, { messageId: null });
  let authorized = loadJSON(AUTHORIZED_FILE, []); // array of Discord user IDs

  // Muat ulang dari MongoDB (jika tersedia) — dipanggil sekali saat startup.
  async function initFromDB() {
    if (!USE_DB()) return false;
    try {
      const b = await db.getBans(cfg.prefix);
      const ch = await db.getConfig(KEY(cfg.prefix, "channel"), null);
      const mg = await db.getConfig(KEY(cfg.prefix, "message"), null);
      const au = await db.getConfig(KEY(cfg.prefix, "authorized"), null);
      if (b && b.length) bans = b.map(({ _id, scope, addedAt, __v, ...rest }) => rest);
      if (ch) channelData = ch;
      if (mg) messageData = mg;
      if (au) authorized = au;
      console.log(`🍃 [${cfg.cmdName}] loaded from MongoDB: ${bans.length} bans, ${authorized.length} authorized`);
      return true;
    } catch (e) {
      console.error(`⚠️  [${cfg.cmdName}] initFromDB gagal:`, e.message);
      return false;
    }
  }

  // Simpan bans — ke DB bila online, selalu juga ke file (safety net).
  function persistBans() {
    saveJSON(BANS_FILE, bans);
    if (USE_DB()) db.saveBans(cfg.prefix, bans);
  }

  async function saveChannelData() {
    saveJSON(CHANNEL_FILE, channelData);
    if (USE_DB()) await db.setConfig(KEY(cfg.prefix, "channel"), channelData);
  }
  async function saveMessageData() {
    saveJSON(MESSAGE_FILE, messageData);
    if (USE_DB()) await db.setConfig(KEY(cfg.prefix, "message"), messageData);
  }
  async function saveAuthorized() {
    saveJSON(AUTHORIZED_FILE, authorized);
    if (USE_DB()) await db.setConfig(KEY(cfg.prefix, "authorized"), authorized);
  }

  if (!channelData.channelId && cfg.defaultChannelId) {
    channelData.channelId = cfg.defaultChannelId;
    saveChannelData();
  }

  // Ensure key users are always in the whitelist
  const SEED_USERS = [OWNER_ID, ...(cfg.seedUsers || [])].filter(Boolean);
  let authChanged = false;
  for (const id of SEED_USERS) {
    if (!authorized.includes(id)) {
      authorized.push(id);
      authChanged = true;
    }
  }
  if (authChanged) saveAuthorized();

  function isAuthorized(userId) {
    return authorized.includes(userId);
  }
  function isOwner(userId) {
    return OWNER_ID ? userId === OWNER_ID : isAuthorized(userId);
  }

  async function cleanExpiredBans(client) {
    const before = bans.length;
    const expired = bans.filter((b) => !isActive(b));
    bans = bans.filter((b) => isActive(b));
    const changed = bans.length !== before;

    if (changed) {
      persistBans();

      // Remove roles for expired bans
      if (client && expired.length > 0) {
        const guild = await getGuildFromChannel(client, channelData);
        if (guild) {
          for (const b of expired) {
            if (b.discordId) {
              await removeBannedRole(guild, b.discordId, cfg.bannedRoleId);
            }
          }
        }
      }
    }

    return changed;
  }

  async function updateBanList(client) {
    try {
      const cid = channelData.channelId;
      if (!cid) return;

      const channel = await client.channels.fetch(cid).catch(() => null);
      if (!channel) {
        console.warn(`[${cfg.cmdName}] Ban-list channel not found – resetting.`);
        channelData.channelId = null;
        messageData.messageId = null;
        saveChannelData();
        saveMessageData();
        return;
      }

      const active = bans.filter((b) => isActive(b));
      const embed = new EmbedBuilder()
        .setTitle("📋 **BANNED PLAYERS LIST**")
        .setColor(active.length > 0 ? 0xff4444 : 0x44ff44)
        .setFooter({
          text: `Total: ${active.length} player(s) banned  •  Starts: ${fmtDate(
            getNextMonday().toISOString()
          )}`,
        })
        .setTimestamp();

      if (active.length === 0) {
        embed.setDescription("No players are currently banned. 🎉");
      } else {
        const school = active.filter((b) => b.type === "school");
        const makyo = active.filter((b) => b.type === "makyo");
        const both = active.filter((b) => b.type === "both");
        const lines = [];

        if (school.length) {
          lines.push("**🚫 Banned from School**");
          school.forEach((b, i) => {
            const end = fmtDate(b.endDateSchool);
            const r = b.reason ? ` — *${b.reason}*` : "";
            const start = fmtDate(b.startDate);
            lines.push(`\`${i + 1}.\` **${b.discordId ? `<@${b.discordId}>` : b.name}**${b.gameId ? ` \`[ID: ${b.gameId}]\`` : ""} ─ ${start} → ${end}${r}`);
          });
          lines.push("");
        }

        if (makyo.length) {
          lines.push("**🚫 Banned from Makyo**");
          makyo.forEach((b, i) => {
            const start = fmtDate(b.startDate);
            const end = fmtDate(b.endDateMakyo);
            const r = b.reason ? ` — *${b.reason}*` : "";
            lines.push(`\`${i + 1}.\` **${b.discordId ? `<@${b.discordId}>` : b.name}**${b.gameId ? ` \`[ID: ${b.gameId}]\`` : ""} ─ ${start} → ${end}${r}`);
          });
          lines.push("");
        }

        if (both.length) {
          lines.push("**🚫 Banned from Makyo & School**");
          both.forEach((b, i) => {
            const sEnd = fmtDate(b.endDateSchool);
            const mEnd = fmtDate(b.endDateMakyo);
            const r = b.reason ? ` — *${b.reason}*` : "";

            const now = new Date();
            const sAlive = !b.endDateSchool || new Date(b.endDateSchool) > now;
            const mAlive = !b.endDateMakyo || new Date(b.endDateMakyo) > now;
            const sTag = sAlive ? "✅" : "❌";
            const mTag = mAlive ? "✅" : "❌";

            const start = fmtDate(b.startDate);
            lines.push(
              `\`${i + 1}.\` **${b.discordId ? `<@${b.discordId}>` : b.name}**${b.gameId ? ` \`[ID: ${b.gameId}]\`` : ""} — ${start} → ${sTag} School: ${sEnd}  |  ${mTag} Makyo: ${mEnd}${r}`
            );
          });
          lines.push("");
        }

        embed.setDescription(lines.join("\n").trim());
      }

      // Edit existing message, or send a new one
      if (messageData.messageId) {
        try {
          const msg = await channel.messages.fetch(messageData.messageId);
          await msg.edit({ embeds: [embed] });
          return;
        } catch {
          messageData.messageId = null;
        }
      }

      const msg = await channel.send({ embeds: [embed] });
      messageData.messageId = msg.id;
      saveMessageData();
      channelData.channelId = channel.id;
      saveChannelData();
    } catch (err) {
      console.error(`[${cfg.cmdName}] updateBanList error:`, err);
    }
  }

  function buildCommand() {
    const bannedCmd = new SlashCommandBuilder()
      .setName(cfg.cmdName)
      .setDescription("Manage player bans");

    // subcommand: add
    bannedCmd.addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a new ban")
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("Ban type")
            .setRequired(true)
            .addChoices(
              { name: "From School", value: "school" },
              { name: "From Makyo", value: "makyo" },
              { name: "From Makyo & School", value: "both" }
            )
        )
        .addStringOption((o) =>
          o.setName("name").setDescription("Player name or @mention").setRequired(true)
        )
        .addIntegerOption((o) =>
          o
            .setName("duration_school")
            .setDescription("Duration in days (leave empty = permanent)")
        )
        .addIntegerOption((o) =>
          o
            .setName("duration_makyo")
            .setDescription("Duration in days (leave empty = permanent)")
        )
        .addStringOption((o) => o.setName("reason").setDescription("Reason for the ban"))
        .addStringOption((o) =>
          o.setName("game_id").setDescription("In-game player ID (optional)")
        )
    );

    // subcommand: remove
    bannedCmd.addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a ban")
        .addStringOption((o) =>
          o.setName("name").setDescription("Player name or @mention").setRequired(true)
        )
    );

    // subcommand: announce
    bannedCmd.addSubcommand((sub) =>
      sub.setName("announce").setDescription("Send an update notification to the ban list channel")
    );

    // subcommand: setup
    bannedCmd.addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Set this channel as the ban-list message destination")
    );

    // subcommand group: whitelist
    bannedCmd.addSubcommandGroup((group) =>
      group
        .setName("whitelist")
        .setDescription("Manage authorized users")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Add a user to whitelist (owner only)")
            .addUserOption((o) =>
              o.setName("user").setDescription("User to add").setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Remove a user from whitelist (owner only)")
            .addUserOption((o) =>
              o.setName("user").setDescription("User to remove").setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("Show all authorized users")
        )
    );

    return bannedCmd;
  }

  async function handleInteraction(interaction, client) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== cfg.cmdName) return;

    const sub = interaction.options.getSubcommand();
    const subGroup = interaction.options.getSubcommandGroup();

    // ─── Authorization ─────────────────────────────────────────────────────────
    // whitelist list → public;  whitelist add/remove → owner only
    if (subGroup === "whitelist") {
      if (sub === "add" || sub === "remove") {
        if (!isOwner(interaction.user.id)) {
          return interaction.reply({
            content: "❌ Only the bot owner can manage the whitelist.",
            ephemeral: true,
          });
        }
      }
    } else {
      if (authorized.length === 0) {
        authorized.push(interaction.user.id);
        saveAuthorized();
        console.log(`ℹ️  Auto-authorized ${interaction.user.tag} (${interaction.user.id})`);
      } else if (!isAuthorized(interaction.user.id)) {
        return interaction.reply({
          content: "❌ You don't have permission to use this command.",
          ephemeral: true,
        });
      }
    }

    // ─────── WHITELIST ADD ─────────────────────────────────────────────────────
    if (subGroup === "whitelist" && sub === "add") {
      const target = interaction.options.getUser("user");
      if (authorized.includes(target.id)) {
        return interaction.reply({
          content: `⚠️ **${target.tag}** is already in the whitelist.`,
          ephemeral: true,
        });
      }
      authorized.push(target.id);
      saveAuthorized();
      return interaction.reply({
        content: `✅ **${target.tag}** added to the whitelist.`,
        ephemeral: true,
      });
    }

    // ─────── WHITELIST REMOVE ──────────────────────────────────────────────────
    if (subGroup === "whitelist" && sub === "remove") {
      const target = interaction.options.getUser("user");
      if (OWNER_ID && target.id === OWNER_ID) {
        return interaction.reply({
          content: "❌ Cannot remove the owner from the whitelist.",
          ephemeral: true,
        });
      }
      const idx = authorized.indexOf(target.id);
      if (idx === -1) {
        return interaction.reply({
          content: `⚠️ **${target.tag}** is not in the whitelist.`,
          ephemeral: true,
        });
      }
      authorized.splice(idx, 1);
      saveAuthorized();
      return interaction.reply({
        content: `✅ **${target.tag}** removed from the whitelist.`,
        ephemeral: true,
      });
    }

    // ─────── WHITELIST LIST ────────────────────────────────────────────────────
    if (subGroup === "whitelist" && sub === "list") {
      if (authorized.length === 0) {
        return interaction.reply({
          content: "📋 Whitelist is empty.",
          ephemeral: true,
        });
      }
      const lines = authorized.map(
        (id, i) =>
          `\`${i + 1}.\` <@${id}>${OWNER_ID && id === OWNER_ID ? " 👑" : ""}`
      );
      return interaction.reply({
        content: `**📋 Authorized Users (${authorized.length})**\n${lines.join("\n")}`,
        ephemeral: true,
      });
    }

    // ─────── ADD ────────────────────────────────────────────────────────────────
    if (sub === "add") {
      await interaction.deferReply({ ephemeral: true });

      let type = interaction.options.getString("type");
      const rawName = interaction.options.getString("name");
      const durationSchool = interaction.options.getInteger("duration_school");
      const durationMakyo = interaction.options.getInteger("duration_makyo");
      const reason = interaction.options.getString("reason");

      let { name, discordId, member } = await resolveName(interaction.guild, rawName);

      // Optional in-game player ID
      const gameId = (interaction.options.getString("game_id") || "").trim() || null;

      // Duplicate check
      if (bans.some((b) => b.name.toLowerCase() === name.toLowerCase() && isActive(b))) {
        return interaction.editReply({
          content: `❌ **${name}** already has an active ban.`,
        });
      }

      // Normalize: treat 0 as "not set" (permanent)
      let schoolDays = type === "school" || type === "both" ? durationSchool : null;
      let makyoDays = type === "makyo" || type === "both" ? durationMakyo : null;
      if (schoolDays === 0) schoolDays = null;
      if (makyoDays === 0) makyoDays = null;

      // Validation
      if (schoolDays != null && schoolDays < 1)
        return interaction.editReply({ content: "❌ School duration must be at least 1 day." });
      if (makyoDays != null && makyoDays < 1)
        return interaction.editReply({ content: "❌ Makyo duration must be at least 1 day." });

      // Auto-adjust type: if one duration is 0 (null after normalize), skip that category
      if (type === "both") {
        if (schoolDays === null && makyoDays !== null) {
          type = "makyo";
        } else if (makyoDays === null && schoolDays !== null) {
          type = "school";
        }
        // if both null (0+0) or both set → keep "both"
      }

      // Build ban object
      const banStartDate = getNextMonday().toISOString();
      const ban = {
        id: uid(),
        name,
        type,
        discordId,
        gameId,
        startDate: banStartDate,
        reason: reason || null,
        createdAt: new Date().toISOString(),
        createdBy: interaction.user.tag,
      };

      if (type === "school") {
        ban.durationSchool = schoolDays;
        ban.endDateSchool = calcEndDate(schoolDays);
      } else if (type === "makyo") {
        ban.durationMakyo = makyoDays;
        ban.endDateMakyo = calcEndDate(makyoDays);
      } else {
        ban.durationSchool = schoolDays;
        ban.endDateSchool = calcEndDate(schoolDays);
        ban.durationMakyo = makyoDays;
        ban.endDateMakyo = calcEndDate(makyoDays);
      }

      bans.push(ban);
      persistBans();

      // Auto-set channel on first ban
      if (!channelData.channelId) {
        channelData.channelId = interaction.channel.id;
        saveChannelData();
      }

      await updateBanList(client);

      // Assign banned role if Discord member was mentioned
      if (discordId && member) {
        await assignBannedRole(member, cfg.bannedRoleId);
      }

      // Build reply
      let reply = `✅ **${name}** has been banned`;
      if (type === "school") {
        reply += ` from **School**`;
        reply += schoolDays ? ` for **${schoolDays} day(s)**` : " **PERMANENT**";
      } else if (type === "makyo") {
        reply += ` from **Makyo**`;
        reply += makyoDays ? ` for **${makyoDays} day(s)**` : " **PERMANENT**";
      } else {
        reply += ` from **Makyo & School**`;
        const s = schoolDays ? `**${schoolDays} day(s)**` : "**PERMANENT**";
        const m = makyoDays ? `**${makyoDays} day(s)**` : "**PERMANENT**";
        reply += `\n  • School: ${s}\n  • Makyo: ${m}`;
      }
      reply += `\n📅 Punishment starts: **${fmtDate(getNextMonday().toISOString())}**`;

      // Punishment end
      if (type === "school") {
        const end = schoolDays ? calcEndDate(schoolDays) : null;
        reply += `\n📅 Punishment ends: **${fmtDate(end)}**`;
      } else if (type === "makyo") {
        const end = makyoDays ? calcEndDate(makyoDays) : null;
        reply += `\n📅 Punishment ends: **${fmtDate(end)}**`;
      } else {
        const sEnd = schoolDays ? calcEndDate(schoolDays) : null;
        const mEnd = makyoDays ? calcEndDate(makyoDays) : null;
        reply += `\n📅 Punishment ends:\n  • School: **${fmtDate(sEnd)}**\n  • Makyo: **${fmtDate(mEnd)}**`;
      }

      if (reason) reply += `\n📝 Reason: *${reason}*`;
      if (gameId) reply += `\n🎮 Game ID: \`${gameId}\``;

      return interaction.editReply({ content: reply });
    }

    // ─────── REMOVE ─────────────────────────────────────────────────────────────
    if (sub === "remove") {
      await interaction.deferReply({ ephemeral: true });

      const rawName = interaction.options.getString("name");
      const { name } = await resolveName(interaction.guild, rawName);

      const idx = bans.findIndex((b) => b.name.toLowerCase() === name.toLowerCase());
      if (idx === -1) {
        return interaction.editReply({
          content: `❌ No ban found for **${name}**.`,
        });
      }

      const removedBan = bans[idx];
      bans.splice(idx, 1);
      persistBans();
      await updateBanList(client);
      // Remove banned role if player was a Discord member
      if (removedBan.discordId) {
        await removeBannedRole(interaction.guild, removedBan.discordId, cfg.bannedRoleId);
      }
      return interaction.editReply({ content: `✅ **${name}** has been unbanned.` });
    }

    // ─────── ANNOUNCE ───────────────────────────────────────────────────────────
    if (sub === "announce") {
      await interaction.deferReply({ ephemeral: true });

      const cid = channelData.channelId;
      if (!cid) {
        return interaction.editReply({ content: "❌ Ban list channel not set. Use `/" + cfg.cmdName + " setup` first." });
      }

      const channel = await client.channels.fetch(cid).catch(() => null);
      if (!channel) {
        return interaction.editReply({ content: "❌ Ban list channel not found." });
      }

      await channel.send({
        content: `<@&${ANNOUNCE_ROLE_ID}> 📢 **Ban list has been updated!** Check the list above for details.`,
      });

      return interaction.editReply({ content: "✅ Announcement sent to the ban list channel." });
    }

    // ─────── SETUP ──────────────────────────────────────────────────────────────
    if (sub === "setup") {
      await interaction.deferReply({ ephemeral: true });

      channelData.channelId = interaction.channel.id;
      messageData.messageId = null;
      saveChannelData();
      saveMessageData();

      await updateBanList(client);
      return interaction.editReply({
        content: `✅ This channel has been set as the ban list destination.`,
      });
    }
  }

  return { buildCommand, handleInteraction, cleanExpiredBans, updateBanList, isAuthorized, initFromDB, persistBans, saveChannelData, saveMessageData, saveAuthorized };
}

// ─── Instantiate the two independent ban systems ──────────────────────────────
const bannedSystem = createBanSystem({
  cmdName: "banned",
  prefix: "ban",
  defaultChannelId: DEFAULT_CHANNEL_ID,
  bannedRoleId: BANNED_ROLE_ID,
  seedUsers: ["980138308631924856"],
});

const nvmbanSystem = createBanSystem({
  cmdName: "nvmban",
  prefix: "nvmban",
  defaultChannelId: "1541795973846540529", // default target channel for nvmban
  bannedRoleId: BANNED_ROLE_ID,
  seedUsers: ["980138308631924856"],
});

// =============================================================================
//  DISCORD CLIENT
// =============================================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // ── Bounty command (separate from /banned) ─────────────────────────────────
  const bountyCmd = new SlashCommandBuilder()
    .setName("bounty")
    .setDescription("Announce a new cursed spirit hunting bounty")
    .addStringOption((o) =>
      o.setName("nickname").setDescription("Player nickname").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("id").setDescription("Player ID").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for bounty").setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel to post the bounty (default: hunt channel)")
        .addChannelTypes(ChannelType.GuildText)
    );

  // ── Create Announce command ─────────────────────────────────────────────────
  const createAnnounceCmd = new SlashCommandBuilder()
    .setName("createannounce")
    .setDescription("Send an announcement (image + text) to the hunt channel")
    .addStringOption((o) =>
      o.setName("text").setDescription("Announcement text").setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel to send the announcement (default: hunt channel)")
        .addChannelTypes(ChannelType.GuildText)
    );

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    const commands = [
      bannedSystem.buildCommand().toJSON(),
      nvmbanSystem.buildCommand().toJSON(),
      bountyCmd.toJSON(),
      createAnnounceCmd.toJSON(),
    ];
    if (GUILD_IDS.length > 0) {
      for (const gid of GUILD_IDS) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid.trim()), { body: commands });
        console.log(`✅ Commands registered for guild ${gid.trim()}`);
      }
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Global commands registered");
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }

  // ── Startup housekeeping ───────────────────────────────────────────────────
  // Konek MongoDB lalu muat data dari Atlas (fallback: file JSON lokal)
  const mongoOk = await db.connect(process.env.MONGO_URI || MONGO_URI);
  if (mongoOk) {
    await bannedSystem.initFromDB();
    await nvmbanSystem.initFromDB();
  }

  await bannedSystem.cleanExpiredBans(client);
  await bannedSystem.updateBanList(client);
  await nvmbanSystem.cleanExpiredBans(client);
  await nvmbanSystem.updateBanList(client);

  // ── Cron: Check for expired bans every minute ───────────────────────────────
  cron.schedule(
    "* * * * *",
    async () => {
      if (await bannedSystem.cleanExpiredBans(client)) await bannedSystem.updateBanList(client);
      if (await nvmbanSystem.cleanExpiredBans(client)) await nvmbanSystem.updateBanList(client);
    },
    { timezone: "Asia/Jakarta" }
  );

  // ── Cron: Friday 20:50 WIB — Malevolent Shrine reminder ────────────────────
  cron.schedule(
    "50 20 * * 5",
    async () => {
      const channel = await client.channels.fetch(REMINDER_FRIDAY_CHANNEL_ID).catch(() => null);
      if (!channel) {
        console.error("Friday reminder channel not found");
        return;
      }
      await channel.send(
        "🔮 @everyone **Don't forget to reinforce Malevolent Shrine!** 🔮\n" +
        "☠️ The cursed spirits grow stronger every day. Strengthen the barrier before it's too late! ⛩️"
      );
    },
    { timezone: "Asia/Jakarta" }
  );

  // ── Cron: Saturday 20:50 WIB — School contest reminder ─────────────────────
  cron.schedule(
    "50 20 * * 6",
    async () => {
      const channel = await client.channels.fetch(REMINDER_SATURDAY_CHANNEL_ID).catch(() => null);
      if (!channel) {
        console.error("Saturday reminder channel not found");
        return;
      }
      await channel.send(
        "🏆 @everyone **Get ready for School contest!** 🏆\n" +
        "📚 Do your best and achieve victory! 🔥\n" +
        "💪 Train hard, fight harder! Let's show them what we've got! 🥇"
      );
    },
    { timezone: "Asia/Jakarta" }
  );
});

// =============================================================================
//  MESSAGE CHATBOT
// =============================================================================

client.on("messageCreate", async (message) => {
  // Ignore bots and slash commands
  if (message.author.bot) return;
  if (message.content.startsWith("/")) return;

  // Only respond if: (1) bot is mentioned, OR (2) user is replying to bot's message
  const isMentioned = message.mentions.users.has(client.user.id);
  const isReplyToBot = message.reference?.messageId
    ? (async () => {
        try {
          const ref = await message.channel.messages.fetch(message.reference.messageId);
          return ref.author.id === client.user.id;
        } catch {
          return false;
        }
      })()
    : false;

  if (!isMentioned && !(await isReplyToBot)) return;

  // Clean the message: remove the bot mention if present
  let cleanContent = message.content;
  if (isMentioned) {
    cleanContent = cleanContent.replace(/<@!?\d+>/g, "").trim();
  }
  if (!cleanContent) cleanContent = "Hey";

  // Show typing indicator
  await message.channel.sendTyping();

  const reply = await getAIResponse(message.channel.id, cleanContent);
  if (reply) {
    await message.reply(reply);
  }
});

// =============================================================================
//  BAN SYSTEM INTERACTION HANDLERS
// =============================================================================

client.on("interactionCreate", (interaction) => bannedSystem.handleInteraction(interaction, client));
client.on("interactionCreate", (interaction) => nvmbanSystem.handleInteraction(interaction, client));

// =============================================================================
//  BOUNTY COMMAND HANDLER
// =============================================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "bounty") return;

  await interaction.deferReply({ ephemeral: true });

  if (!isAuthorizedGlobal(interaction.user.id)) {
    return interaction.editReply({ content: "❌ You don't have permission to use this command." });
  }

  const nickname = interaction.options.getString("nickname");
  const targetId = interaction.options.getString("id");
  const reason = interaction.options.getString("reason");

  const channelOpt = interaction.options.getChannel("channel");
  const huntChannel = channelOpt || (await client.channels.fetch(HUNT_CHANNEL_ID).catch(() => null));
  if (!huntChannel) {
    return interaction.editReply({ content: "❌ Bounty announcement channel not found." });
  }

  const huntEmbed = new EmbedBuilder()
    .setTitle("⚔️ **CURSED SPIRIT HUNTING** ⚔️")
    .setColor(0x9b59b6)
    .setImage("attachment://bounty.png")
    .setDescription(
      "👁️ A new cursed spirit has been identified and marked for extermination.\n\n" +
      "**🎯 TARGET**\n" +
      `• **Nickname:** ${nickname}\n` +
      `• **ID:** \`${targetId}\`\n\n` +
      "**📋 REASON**\n" +
      `> ${reason}\n\n` +
      "⚡ All available sorcerers are hereby authorized to hunt this target.\n" +
      "🍀 May your cursed energy lead you to victory."
    )
    .setFooter({ text: "Cursed Spirit Hunting Division" })
    .setTimestamp();

  await huntChannel.send({
    content: "@everyone",
    embeds: [huntEmbed],
    files: ["./bounty.png"],
  });

  return interaction.editReply({
    content: `✅ Bounty for **${nickname}** has been announced in <#${huntChannel.id}>.`,
  });
});

// =============================================================================
//  CREATE ANNOUNCE COMMAND HANDLER
// =============================================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "createannounce") return;

  const text = interaction.options.getString("text");

  // Authorization: HANYA user-ID tertentu yang diizinkan pakai fitur ini
  const ALLOWED_USER_IDS = ["980138308631924856", "591607910816284672"];
  if (!ALLOWED_USER_IDS.includes(interaction.user.id)) {
    return interaction.reply({
      content: "❌ You don't have permission to use this command.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const channelOpt = interaction.options.getChannel("channel");
  const channel = channelOpt || (await client.channels.fetch(HUNT_CHANNEL_ID).catch(() => null));
  if (!channel) {
    return interaction.editReply({ content: "❌ Announcement channel not found." });
  }

  // Kirim foto dulu, lalu announcement-nya menyusul
  await channel.send({ files: ["./Announcement.webp"] });
  await channel.send({ content: `@everyone\n${text}` });

  return interaction.editReply({
    content: `✅ Announcement sent to <#${channel.id}>.`,
  });
});

// =============================================================================
//  GLOBAL AUTHORIZATION HELPER (for /bounty)
// =============================================================================

// /bounty shares the `banned` system's whitelist.
function isAuthorizedGlobal(userId) {
  return bannedSystem.isAuthorized(userId);
}

// =============================================================================
//  ERROR HANDLING
// =============================================================================

client.on("error", (err) => console.error("Client error:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

// =============================================================================
//  START
// =============================================================================

client.login(TOKEN);