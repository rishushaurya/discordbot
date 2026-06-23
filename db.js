const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const path = require('path');

let db = null;

async function initDb() {
  if (db) return db;

  db = await open({
    filename: path.join(__dirname, 'lilgooner.db'),
    driver: sqlite3.Database
  });

  // Enable WAL mode for performance
  await db.run('PRAGMA journal_mode = WAL;');

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS personality_config (
      guild_id TEXT PRIMARY KEY,
      toxicity_level INTEGER DEFAULT 5,
      slang_intensity INTEGER DEFAULT 7,
      emoji_frequency INTEGER DEFAULT 4,
      banned_phrases TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS aura_points (
      user_id TEXT PRIMARY KEY,
      points INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS banish_bless (
      user_id TEXT PRIMARY KEY,
      status TEXT, -- 'banished' | 'blessed'
      expires_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_nicknames (
      user_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nsfw_access (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS server_mood (
      guild_id TEXT PRIMARY KEY,
      mood TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  return db;
}

// ----------------------------------------------------
// personality_config methods
// ----------------------------------------------------
async function getPersonalityConfig(guildId) {
  await initDb();
  // Default values as per spec
  const defaults = {
    guild_id: guildId,
    toxicity_level: 5,
    slang_intensity: 7,
    emoji_frequency: 4,
    banned_phrases: '[]'
  };

  if (!guildId) return defaults;

  const row = await db.get('SELECT * FROM personality_config WHERE guild_id = ?', [guildId]);
  if (!row) {
    // Insert defaults
    await db.run(
      'INSERT INTO personality_config (guild_id, toxicity_level, slang_intensity, emoji_frequency, banned_phrases) VALUES (?, ?, ?, ?, ?)',
      [guildId, defaults.toxicity_level, defaults.slang_intensity, defaults.emoji_frequency, defaults.banned_phrases]
    );
    return defaults;
  }
  return row;
}

async function updatePersonalityConfig(guildId, updates) {
  await initDb();
  const current = await getPersonalityConfig(guildId);
  const toxicity = updates.toxicity_level !== undefined ? updates.toxicity_level : current.toxicity_level;
  const slang = updates.slang_intensity !== undefined ? updates.slang_intensity : current.slang_intensity;
  const emoji = updates.emoji_frequency !== undefined ? updates.emoji_frequency : current.emoji_frequency;
  const banned = updates.banned_phrases !== undefined ? updates.banned_phrases : current.banned_phrases;

  await db.run(
    `INSERT INTO personality_config (guild_id, toxicity_level, slang_intensity, emoji_frequency, banned_phrases, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(guild_id) DO UPDATE SET
      toxicity_level = excluded.toxicity_level,
      slang_intensity = excluded.slang_intensity,
      emoji_frequency = excluded.emoji_frequency,
      banned_phrases = excluded.banned_phrases,
      updated_at = CURRENT_TIMESTAMP`,
    [guildId, toxicity, slang, emoji, banned]
  );
  return getPersonalityConfig(guildId);
}

// ----------------------------------------------------
// user_nicknames methods
// ----------------------------------------------------
async function setNickname(userId, nickname) {
  await initDb();
  await db.run(
    'INSERT INTO user_nicknames (user_id, nickname) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname',
    [userId, nickname]
  );
}

async function getNickname(userId) {
  await initDb();
  const row = await db.get('SELECT nickname FROM user_nicknames WHERE user_id = ?', [userId]);
  return row ? row.nickname : null;
}

async function removeNickname(userId) {
  await initDb();
  await db.run('DELETE FROM user_nicknames WHERE user_id = ?', [userId]);
}

// ----------------------------------------------------
// resetPersonalityConfig
// ----------------------------------------------------
async function resetPersonalityConfig(guildId) {
  await initDb();
  await db.run(
    `INSERT INTO personality_config (guild_id, toxicity_level, slang_intensity, emoji_frequency, banned_phrases, updated_at)
     VALUES (?, 5, 7, 4, '[]', CURRENT_TIMESTAMP)
     ON CONFLICT(guild_id) DO UPDATE SET
      toxicity_level = 5,
      slang_intensity = 7,
      emoji_frequency = 4,
      banned_phrases = '[]',
      updated_at = CURRENT_TIMESTAMP`,
    [guildId]
  );
  return getPersonalityConfig(guildId);
}

// ----------------------------------------------------
// aura_points methods
// ----------------------------------------------------
async function getAuraPoints(userId) {
  await initDb();
  const row = await db.get('SELECT points FROM aura_points WHERE user_id = ?', [userId]);
  return row ? row.points : 0;
}

async function adjustAuraPoints(userId, change) {
  await initDb();
  const current = await getAuraPoints(userId);
  const newPoints = current + change;
  await db.run(
    'INSERT INTO aura_points (user_id, points) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET points = excluded.points',
    [userId, newPoints]
  );
  return newPoints;
}

async function getAuraLeaderboard(limit = 10) {
  await initDb();
  return await db.all('SELECT user_id, points FROM aura_points ORDER BY points DESC LIMIT ?', [limit]);
}

// ----------------------------------------------------
// banish_bless methods
// ----------------------------------------------------
async function getBanishBlessStatus(userId) {
  await initDb();
  const row = await db.get('SELECT status, expires_at FROM banish_bless WHERE user_id = ?', [userId]);
  if (!row) return null;

  const expiresAt = new Date(row.expires_at);
  if (expiresAt < new Date()) {
    // Expired, delete from DB
    await db.run('DELETE FROM banish_bless WHERE user_id = ?', [userId]);
    return null;
  }
  return row.status; // 'banished' or 'blessed'
}

async function setBanishBlessStatus(userId, status, durationMinutes) {
  await initDb();
  if (!status) {
    await db.run('DELETE FROM banish_bless WHERE user_id = ?', [userId]);
    return;
  }
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
  await db.run(
    'INSERT INTO banish_bless (user_id, status, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at',
    [userId, status, expiresAt]
  );
}

// ----------------------------------------------------
// nsfw_access methods
// ----------------------------------------------------
async function getNsfwAccess(guildId, userId) {
  await initDb();
  const row = await db.get('SELECT expires_at FROM nsfw_access WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  if (!row) return false;

  if (row.expires_at === null) return true; // Permanent

  const expiresAt = new Date(row.expires_at);
  if (expiresAt < new Date()) {
    // Expired, delete from DB
    await db.run('DELETE FROM nsfw_access WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return false;
  }
  return true;
}

async function setNsfwAccess(guildId, userId, durationMinutes) {
  await initDb();
  let expiresAt = null;
  if (durationMinutes && durationMinutes !== Infinity && durationMinutes > 0) {
    expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
  }
  await db.run(
    'INSERT INTO nsfw_access (guild_id, user_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET expires_at = excluded.expires_at',
    [guildId, userId, expiresAt]
  );
}

async function removeNsfwAccess(guildId, userId) {
  await initDb();
  await db.run('DELETE FROM nsfw_access WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
}

async function getAllNsfwAccess(guildId) {
  await initDb();
  const rows = await db.all('SELECT user_id, expires_at FROM nsfw_access WHERE guild_id = ?', [guildId]);
  const active = [];
  const now = new Date();
  for (const row of rows) {
    if (row.expires_at === null) {
      active.push({ user_id: row.user_id, expires_at: null });
    } else {
      const expiresAt = new Date(row.expires_at);
      if (expiresAt < now) {
        await db.run('DELETE FROM nsfw_access WHERE guild_id = ? AND user_id = ?', [guildId, row.user_id]);
      } else {
        active.push({ user_id: row.user_id, expires_at: expiresAt });
      }
    }
  }
  return active;
}

// ----------------------------------------------------
// server_mood methods
// ----------------------------------------------------
async function getServerMood(guildId) {
  await initDb();
  const row = await db.get('SELECT mood, expires_at FROM server_mood WHERE guild_id = ?', [guildId]);
  if (!row) return null;

  const expiresAt = new Date(row.expires_at);
  if (expiresAt < new Date()) {
    // Expired, delete from DB
    await db.run('DELETE FROM server_mood WHERE guild_id = ?', [guildId]);
    return null;
  }
  return row.mood;
}

async function setServerMood(guildId, mood, durationMinutes = 60) {
  await initDb();
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
  await db.run(
    'INSERT INTO server_mood (guild_id, mood, expires_at) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET mood = excluded.mood, expires_at = excluded.expires_at',
    [guildId, mood, expiresAt]
  );
}

module.exports = {
  initDb,
  getPersonalityConfig,
  updatePersonalityConfig,
  resetPersonalityConfig,
  getAuraPoints,
  adjustAuraPoints,
  getAuraLeaderboard,
  getBanishBlessStatus,
  setBanishBlessStatus,
  setNickname,
  getNickname,
  removeNickname,
  getNsfwAccess,
  setNsfwAccess,
  removeNsfwAccess,
  getAllNsfwAccess,
  getServerMood,
  setServerMood
};
