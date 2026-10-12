// ─── Database layer (MongoDB Atlas) ───────────────────────────
// Pengganti file JSON di ./data/. API-nya sengaja dibikin mirip
// loadJSON/saveJSON supaya pemakaian di index.js minimal berubah:
//   - loadJSON-like : getConfig(key, def) / getArray(key)
//   - saveJSON-like : setConfig(key, data) / setArray(key, arr)
//
// Model:
//   Config  — dokumen key/value (channelId, messageId, authorized list)
//   Ban     — satu dokumen per ban (lebih rapi + queryable)
const mongoose = require('mongoose');

const CONFIG_SCHEMA = new mongoose.Schema({
  key:       { type: String, index: true, unique: true },
  value:     mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false });

const BAN_SCHEMA = new mongoose.Schema({
  scope:      { type: String, index: true },   // 'ban' | 'nvmban'
  name:       String,
  discordId:  String,
  type:       { type: String, index: true },   // school | makyo | both
  reason:     String,
  startDate:  String,   // ISO
  endDateSchool: String,
  endDateMakyo:  String,
  addedBy:    String,
  addedAt:    { type: Date, default: Date.now },
}, { minimize: false });

const Config = mongoose.model('Config', CONFIG_SCHEMA);
const Ban = mongoose.model('Ban', BAN_SCHEMA);

let connected = false;

async function connect(uri) {
  if (!uri) {
    console.log('⚠️  MONGO_URI tidak diset — pakai mode file JSON saja.');
    return false;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    connected = true;
    console.log('✅ MongoDB Atlas connected');
    return true;
  } catch (err) {
    console.error('❌ MongoDB connect gagal:', err.message);
    console.error('   → Bot tetap jalan, data tidak persisten.');
    return false;
  }
}

function isConnected() { return connected && mongoose.connection.readyState === 1; }

// ── Config: get / set (mirip loadJSON / saveJSON) ──────────────
async function getConfig(key, def = null) {
  if (!isConnected()) return def;
  try {
    const doc = await Config.findOne({ key }).lean();
    return doc ? doc.value : def;
  } catch (err) {
    console.error(`⚠️  getConfig(${key}) gagal:`, err.message);
    return def;
  }
}

async function setConfig(key, value) {
  if (!isConnected()) return;
  try {
    await Config.updateOne(
      { key },
      { $set: { value, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error(`⚠️  setConfig(${key}) gagal:`, err.message);
  }
}

// ── Bans: get / set (mirip loadJSON / saveJSON untuk array) ────
// scope = cfg.prefix ('ban' | 'nvmban')
async function getBans(scope) {
  if (!isConnected()) return [];
  try {
    return await Ban.find({ scope }).sort({ addedAt: 1 }).lean();
  } catch (err) {
    console.error(`⚠️  getBans(${scope}) gagal:`, err.message);
    return [];
  }
}

// Tulis ulang seluruh daftar ban untuk scope ini (deleteMany + insertMany).
// Dipanggil dari titik yang dulu pakai saveJSON(BANS_FILE, bans).
async function saveBans(scope, bans) {
  if (!isConnected()) return;
  try {
    await Ban.deleteMany({ scope });
    if (bans.length) {
      await Ban.insertMany(bans.map(b => ({ ...b, scope })));
    }
  } catch (err) {
    console.error(`⚠️  saveBans(${scope}) gagal:`, err.message);
  }
}

module.exports = {
  connect, isConnected,
  getConfig, setConfig,
  getBans, saveBans,
  Config, Ban,
};
