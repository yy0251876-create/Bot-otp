const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
let XLSX = null;
try { XLSX = require('xlsx'); } catch (e) { XLSX = null; }
const fs = require('fs');
const path = require('path');
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();
const cron = require('node-cron');
const settings = require('./settings');
const countriesModule = require('./countries');
const { getCountryCodeFromName, getCountryFlag, getCountryName } = countriesModule;

const P = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    delay
} = require('@whiskeysockets/baileys');

// ============================================================
// FILE KONFIGURASI
// ============================================================
const SENDER_FILE = './senders.json';
const DATA_DIR = path.join(__dirname, "countries");
const DATA_V2_DIR = path.join(__dirname, "countries_v2");
const GROUPS_FILE = './groups.json';
const SESSIONS_DIR = './sessions';
const USER_DATA_FILE = './users.json';
const TRAFFIC_FILE = './traffic.json';
const OTP_HISTORY_FILE = './otp_history.json';
const PREMIUM_FILE = './premium.json';
const USER_QUOTA_FILE = './user_quota.json';
const USER_STATS_FILE = './user_stats.json';
const CHECK_STATS_FILE = './check_stats.json';
const OTP_CONTROL_FILE = './otp_control.json';
const GET_NUMBER_BATCH_SIZE = 10;
const server2PendingUploads = new Map();
const server2V2PendingUploads = new Map();
const takenNumbersV2 = new Map();
const server2UploadTimers = new Map();
const SERVER2_UPLOAD_BATCH_DELAY = 3000; // kumpulkan beberapa file dulu agar 1 batch = 1 pilihan V1/V2

const initFiles = () => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    if (!fs.existsSync(DATA_V2_DIR)) fs.mkdirSync(DATA_V2_DIR);
    if (!fs.existsSync(SENDER_FILE)) fs.writeFileSync(SENDER_FILE, JSON.stringify({}, null, 2));
    if (!fs.existsSync(GROUPS_FILE)) fs.writeFileSync(GROUPS_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);
    if (!fs.existsSync(USER_DATA_FILE)) fs.writeFileSync(USER_DATA_FILE, JSON.stringify({ users: [] }, null, 2));
    if (!fs.existsSync(TRAFFIC_FILE)) fs.writeFileSync(TRAFFIC_FILE, JSON.stringify({ daily: {}, lastReset: Date.now() }, null, 2));
    if (!fs.existsSync(OTP_HISTORY_FILE)) fs.writeFileSync(OTP_HISTORY_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(PREMIUM_FILE)) fs.writeFileSync(PREMIUM_FILE, JSON.stringify({}, null, 2));
    if (!fs.existsSync(USER_QUOTA_FILE)) fs.writeFileSync(USER_QUOTA_FILE, JSON.stringify({}, null, 2));
    if (!fs.existsSync(USER_STATS_FILE)) fs.writeFileSync(USER_STATS_FILE, JSON.stringify({}, null, 2));
    if (!fs.existsSync(CHECK_STATS_FILE)) fs.writeFileSync(CHECK_STATS_FILE, JSON.stringify({ checked: 0, registered: 0, business: 0, personal: 0, ai: 0 }, null, 2));
    if (!fs.existsSync(OTP_CONTROL_FILE)) fs.writeFileSync(OTP_CONTROL_FILE, JSON.stringify({ v1: true, v2: true }, null, 2));
};

initFiles();

const bot = new TelegramBot(settings.BOT_TOKEN, { polling: true });

const OWNER_IDS = Array.from(new Set([settings.OWNER_ID, settings.OWNER_ID_2]
    .filter(v => v !== undefined && v !== null && String(v) !== '' && String(v) !== '0')
    .map(Number)));
const isOwnerId = (userId) => OWNER_IDS.includes(Number(userId));
const sendToOwners = async (text, options = {}) => {
    await Promise.all(OWNER_IDS.map(id => bot.sendMessage(id, text, options).catch(() => {})));
};
const userSession = new Map();
const cekBioStopState = new Map();
const seen_otps = new Set();
const lastBotMessage = new Map();
const takenNumbers = new Map();
const userSessions = new Map();
const userPairingState = new Map();

const isPrivate = (msg) => msg.chat.type === 'private';

// ============================================================
// GET FUNCTIONS
// ============================================================
const getGroups = () => {
    try { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); } catch (e) { return settings.GROUPS || []; }
};

const getOtpControl = () => {
    try {
        const data = JSON.parse(fs.readFileSync(OTP_CONTROL_FILE, 'utf8'));
        return { v1: data.v1 !== false, v2: data.v2 !== false };
    } catch (e) {
        return { v1: true, v2: true };
    }
};

const setOtpControl = (server, enabled) => {
    const current = getOtpControl();
    current[server] = Boolean(enabled);
    fs.writeFileSync(OTP_CONTROL_FILE, JSON.stringify(current, null, 2));
    return current;
};

const getUsers = () => {
    try {
        if (!fs.existsSync(USER_DATA_FILE)) {
            fs.writeFileSync(USER_DATA_FILE, JSON.stringify({ users: [] }, null, 2));
            return [];
        }
        const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
        if (!data.users || !Array.isArray(data.users)) {
            data.users = [];
            fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
            return [];
        }
        return data.users;
    } catch (e) { return []; }
};

const addUser = (userId) => {
    try {
        const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
        if (!data.users.includes(userId)) {
            data.users.push(userId);
            fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
            return true;
        }
        return false;
    } catch (e) { return false; }
};

const getTotalUsers = () => {
    try { return JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8')).users.length; } catch (e) { return 0; }
};

// ============================================================
// SEND HELPERS
// ============================================================
const sendBQ = async (chatId, text, options = {}) => {
    return bot.sendMessage(chatId, `<blockquote>${text}</blockquote>`, { parse_mode: 'HTML', ...options });
};

const clearBotChat = (chatId) => {
    if (lastBotMessage.has(chatId)) {
        bot.deleteMessage(chatId, lastBotMessage.get(chatId)).catch(() => {});
        lastBotMessage.delete(chatId);
    }
};

const sendClean = async (chatId, text, options = {}, forceDelete = true) => {
    if (forceDelete) clearBotChat(chatId);
    const sent = await bot.sendMessage(chatId, `<blockquote>${text}</blockquote>`, { parse_mode: 'HTML', ...options });
    lastBotMessage.set(chatId, sent.message_id);
};

// ============================================================
// CHECK STATS
// ============================================================
const getCheckStats = () => {
    try {
        const data = JSON.parse(fs.readFileSync(CHECK_STATS_FILE, 'utf8'));
        return { checked: 0, registered: 0, business: 0, personal: 0, ai: 0, ...data };
    } catch (e) { return { checked: 0, registered: 0, business: 0, personal: 0, ai: 0 }; }
};

const recordCheckResults = (results = []) => {
    if (!Array.isArray(results) || !results.length) return;
    const stats = getCheckStats();
    stats.checked += results.length;
    stats.registered += results.filter(r => r.registered).length;
    stats.business += results.filter(r => r.registered && r.accountType === 'business').length;
    stats.personal += results.filter(r => r.registered && r.accountType !== 'business').length;
    stats.ai += results.filter(r => r.registered && r.isAiAgent).length;
    fs.writeFileSync(CHECK_STATS_FILE, JSON.stringify(stats, null, 2));
};

// ============================================================
// PREMIUM
// ============================================================
const getPremiumUsers = () => {
    try { return JSON.parse(fs.readFileSync(PREMIUM_FILE, 'utf8')); } catch (e) { return {}; }
};
const savePremiumUsers = (data) => { fs.writeFileSync(PREMIUM_FILE, JSON.stringify(data, null, 2)); };

const getPrice = (days) => {
    const prices = { 2:'1K',4:'2K',6:'3K',8:'4K',10:'5K',12:'6K',14:'7K',16:'8K',18:'9K',20:'10K',22:'11K',24:'12K',26:'13K',28:'14K',30:'15K',60:'30K',90:'45K' };
    return prices[days] || `${Math.ceil(days / 2)}K`;
};

const isPremium = (userId) => {
    const premium = getPremiumUsers();
    const user = premium[userId];
    if (!user) return false;
    if (user.expired && new Date(user.expired) < new Date()) {
        delete premium[userId];
        savePremiumUsers(premium);
        return false;
    }
    return true;
};

const getPremiumExpired = (userId) => getPremiumUsers()[userId]?.expired || null;

const addPremiumUser = (userId, days, price) => {
    const premium = getPremiumUsers();
    const now = new Date();
    const expired = new Date(now);
    expired.setDate(expired.getDate() + days);
    premium[userId] = { expired: expired.toISOString(), package: days + " Hari", price, added_at: now.toISOString(), added_by: settings.OWNER_ID };
    savePremiumUsers(premium);
    return true;
};

const removePremiumUser = (userId) => {
    const premium = getPremiumUsers();
    if (premium[userId]) { delete premium[userId]; savePremiumUsers(premium); return true; }
    return false;
};

// ============================================================
// QUOTA
// ============================================================
const getUserQuota = (userId) => {
    try {
        const data = JSON.parse(fs.readFileSync(USER_QUOTA_FILE, 'utf8'));
        const today = new Date().toDateString();
        if (!data[userId] || data[userId].date !== today) return { date: today, count: 0 };
        return data[userId];
    } catch (e) { return { date: new Date().toDateString(), count: 0 }; }
};

const saveUserQuota = (userId, quota) => {
    try {
        const data = JSON.parse(fs.readFileSync(USER_QUOTA_FILE, 'utf8'));
        data[userId] = quota;
        fs.writeFileSync(USER_QUOTA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        const data = {};
        data[userId] = quota;
        fs.writeFileSync(USER_QUOTA_FILE, JSON.stringify(data, null, 2));
    }
};

const getTotalQuota = () => 5;

const resetQuotaDaily = () => {
    fs.writeFileSync(USER_QUOTA_FILE, JSON.stringify({}, null, 2));
    console.log("🔄 Quota user di-reset!");
};

// ============================================================
// USER STATS
// ============================================================
const getUserStats = () => {
    try { return JSON.parse(fs.readFileSync(USER_STATS_FILE, 'utf8')); } catch (e) { return {}; }
};
const saveUserStats = (data) => { fs.writeFileSync(USER_STATS_FILE, JSON.stringify(data, null, 2)); };

const updateUserStats = (userId, type) => {
    const stats = getUserStats();
    if (!stats[userId]) stats[userId] = { get_number: 0, cek_bio: 0, total: 0, last_active: new Date().toISOString() };
    if (type === 'get_number') stats[userId].get_number++;
    if (type === 'cek_bio') stats[userId].cek_bio++;
    stats[userId].total = stats[userId].get_number + stats[userId].cek_bio;
    stats[userId].last_active = new Date().toISOString();
    saveUserStats(stats);
};

const getTopUsers = (limit = 10) => {
    const stats = getUserStats();
    return Object.entries(stats).sort((a, b) => b[1].total - a[1].total).slice(0, limit);
};

// ============================================================
// SENDER
// ============================================================
const getSenders = () => {
    try { return JSON.parse(fs.readFileSync(SENDER_FILE, 'utf8')); } catch (e) { return {}; }
};
const saveSenders = (data) => { fs.writeFileSync(SENDER_FILE, JSON.stringify(data, null, 2)); };

const addSender = (userId, phone, username) => {
    const senders = getSenders();
    senders[userId] = { phone, username: username || 'Unknown', status: 'connected', connected_at: new Date().toISOString(), platform: 'WhatsApp Web' };
    saveSenders(senders);
};

const removeSender = (userId) => {
    const senders = getSenders();
    if (senders[userId]) { delete senders[userId]; saveSenders(senders); return true; }
    return false;
};

const getActiveSenders = () => {
    const senders = getSenders();
    const active = {};
    for (const [id, data] of Object.entries(senders)) if (data.status === 'connected') active[id] = data;
    return active;
};

const getSenderGlobal = () => {
    const active = getActiveSenders();
    const keys = Object.keys(active);
    if (keys.length === 0) return null;
    return { userId: keys[0], ...active[keys[0]] };
};

// ============================================================
// GET ALL COUNTRIES
// ============================================================
function getAllCountries() {
    if (!fs.existsSync(DATA_DIR)) return [];
    const files = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith('.txt'));
    const grouped = new Map();

    for (const file of files) {
        const code = resolveStockCountryCode(file);
        if (!code) continue;

        const filePath = path.join(DATA_DIR, file);
        let stock = 0;
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            stock = (content.match(/\d{9,15}/g) || []).length;
        } catch (e) {}

        if (!grouped.has(code)) {
            grouped.set(code, {
                code,
                flag: getCountryFlag(code),
                name: getCountryName(code),
                files: [],
                stock: 0
            });
        }

        const item = grouped.get(code);
        item.files.push(file);
        item.stock += stock;
    }

    return [...grouped.values()].filter(x => x.stock > 0);
}

// ============================================================
// NOTIF USER BARU
// ============================================================
const sendNewUserNotif = async (userId, username) => {
    const totalUsers = getTotalUsers();
    let text = `👤 <b>USER BARU MENGGUNAKAN BOT!</b>\n\n📱 User ID: <code>${userId}</code>\n👤 Username: @${username || 'Unknown'}\n📅 Waktu: ${new Date().toLocaleString('id-ID')}\n\n📊 Total User: ${totalUsers}`;
    const keyboard = { inline_keyboard: [[{ text: "📋 COPY ID", copy_text: { text: String(userId) } }]] };
    await sendToOwners(text, { parse_mode: 'HTML', reply_markup: keyboard });
};

// ============================================================
// FORCE JOIN
// ============================================================
const FORCE_JOIN_TARGETS = [
    { name: "GRUP OTP", id: "@otpOrvinz", url: "https://t.me/otpOrvinz" },
    { name: "GRUP MARKET", id: "@marketnokosmyid", url: "https://t.me/marketnokosmyid" },
    { name: "CH METODE", id: "@metodeneww", url: "https://t.me/metodeneww" },
    { name: "CH STOK FILE", id: "@allstokfile", url: "https://t.me/allstokfile" }
];

const isJoined = async (userId) => {
    if (isOwnerId(userId)) return true;

    for (const target of FORCE_JOIN_TARGETS) {
        try {
            const member = await bot.getChatMember(target.id, userId);
            if (member.status === 'left' || member.status === 'kicked') return false;
            if (member.status === 'restricted' && member.is_member === false) return false;
        } catch (e) {
            console.error(`❌ Force Join check gagal ${target.id}:`, e.message);
            return false;
        }
    }
    return true;
};

const getJoinKeyboard = () => ({
    inline_keyboard: [
        [
            { text: "👥 GRUP OTP", url: "https://t.me/otpbashaa" },
            { text: "👥 GRUP MARKET", url: "https://t.me/marketnokosmyid" }
        ],
        [
            { text: "📢 CH METODE", url: "https://t.me/metodeneww" },
            { text: "📢 CH STOK FILE", url: "https://t.me/allstokfile" }
        ],
        [{ text: "✅ SUDAH JOIN / CEK", callback_data: "check_join" }]
    ]
});

const checkAccess = async (msg) => {
    if (await isJoined(msg.from.id)) return true;

    await sendClean(
        msg.chat.id,
        "⚠️ <b>AKSES TERKUNCI</b>\n\nSilakan join <b>SEMUA</b> grup & channel wajib di bawah ini terlebih dahulu.\n\nSetelah selesai, tekan <b>SUDAH JOIN / CEK</b>.",
        { reply_markup: getJoinKeyboard() }
    );
    return false;
};

// ============================================================
// EKSTRAK OTP SMART
// ============================================================
function extractOtpSmart(message) {
    let text = String(message ?? "");
    text = text.replace(/\\n/gi, " ").replace(/\\r/gi, " ").replace(/\\/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
    let match = text.match(/(?:code|kode)\s*[:\-]?\s*(\d{3}[\-\s]?\d{3,4})([A-Za-z0-9\/\+\-]*)/i);
    if (match) {
        let first = (match[1] || "").replace(/\s+/g, "");
        let second = match[2] || "";
        let result = first + second;
        if (!second) {
            const afterIdx = text.indexOf(match[0]) + match[0].length;
            const rest = text.slice(afterIdx);
            const lanjutan = rest.match(/[\s:]*([A-Za-z0-9\/\+]{4,})/);
            if (lanjutan && !/^(do|not|don|share|kode|code|with|jangan)/i.test(lanjutan[1])) result += lanjutan[1];
        }
        return result;
    }
    match = text.match(/(?:otp|verification|verifikasi|pin)\s*(?:code|kode)?\s*[:\-]?\s*([A-Za-z0-9\-]{4,20})/i);
    if (match) return match[1];
    match = text.match(/\b(\d{4,8})\b/);
    if (match) return match[1];
    match = text.match(/\b(\d{3}-\d{3,4})\b/);
    if (match) return match[1];
    return "-";
}

function detectCountryFromNumber(cleanNum) {
    try {
        const number = phoneUtil.parse("+" + cleanNum);
        return phoneUtil.getRegionCodeForNumber(number) || "UNKNOWN";
    } catch (e) { return "UNKNOWN"; }
}

function maskPhoneNumber(phone) {
    const v = String(phone ?? "").replace(/[^0-9]/g, "");
    if (v.length <= 9) return v;
    return v.slice(0, 5) + "XXX" + v.slice(-4);
}

// ============================================================
// OTP HISTORY
// ============================================================
const saveOtpHistory = (data) => {
    let history = [];
    try {
        const content = fs.readFileSync(OTP_HISTORY_FILE, 'utf8');
        history = JSON.parse(content);
        if (!Array.isArray(history)) history = [];
    } catch (e) { history = []; }
    history.push({ timestamp: new Date().toISOString(), ...data });
    fs.writeFileSync(OTP_HISTORY_FILE, JSON.stringify(history, null, 2));
};

const getOtpHistory = () => {
    try { return JSON.parse(fs.readFileSync(OTP_HISTORY_FILE, 'utf8')); } catch (e) { return []; }
};

const getOtpHistoryByCountry = (countryCode) => getOtpHistory().filter(item => (item.country || 'UNKNOWN').toUpperCase() === countryCode.toUpperCase());

const checkOtpByNumber = (phoneNumber) => {
    const history = getOtpHistory();
    const cleanNum = phoneNumber.toString().replace(/[^0-9]/g, '');
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);
    return history.filter(item => {
        const itemNum = item.number.toString().replace(/[^0-9]/g, '');
        return (itemNum.includes(cleanNum) || cleanNum.includes(itemNum)) && new Date(item.timestamp) >= oneHourAgo;
    });
};

function getCountryInfo(phone) {
    try {
        const cleanPhone = phone.toString().replace(/[^0-9]/g, '');
        const number = phoneUtil.parse("+" + cleanPhone);
        return phoneUtil.getRegionCodeForNumber(number) || "UNKNOWN";
    } catch (e) { return "UNKNOWN"; }
}

function getFileAge(filePath) {
    const stats = fs.statSync(filePath);
    return (Date.now() - stats.birthtimeMs) / (1000 * 60 * 60);
}

// ============================================================
// WHATSAPP FUNCTIONS (BAILEYS)
// ============================================================
let cleanPhone = '';

async function startWASession(userId) {
    const sessionPath = path.join(SESSIONS_DIR, String(userId));
    if (fs.existsSync(sessionPath)) {
        try { await useMultiFileAuthState(sessionPath); } catch (e) {
            console.log(`⚠️ Session ${userId} corrupt, hapus...`);
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            version, logger: P({ level: 'silent' }),
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });
        userSessions.set(String(userId), sock);
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(`✅ WhatsApp ${userId} terhubung!`);
                userPairingState.set(String(userId), 'connected');
                try {
                    const user = await bot.getChat(userId);
                    const username = user.username || user.first_name || 'Unknown';
                    addSender(userId, cleanPhone, username);
                } catch (e) {}
                if (!userPairingState.get(String(userId) + '_notified')) {
                    await bot.sendMessage(userId, `╭━━━〔 ✅ WHATSAPP TERHUBUNG 〕━━━╮\n│\n├─ WhatsApp berhasil terhubung!\n├─ Sekarang Anda bisa cek bio nomor.\n│\n╰━━━〔 🚀 SELAMAT MENGGUNAKAN 〕━━━╯`, { parse_mode: 'HTML' }).catch(() => {});
                    userPairingState.set(String(userId) + '_notified', true);
                }
            }
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
                    userPairingState.set(String(userId), 'disconnected');
                    userSessions.delete(String(userId));
                    userPairingState.delete(String(userId) + '_notified');
                    const senders = getSenders();
                    if (senders[userId]) {
                        senders[userId].status = 'disconnected';
                        senders[userId].disconnected_at = new Date().toISOString();
                        senders[userId].reason = code === 403 ? 'Banned' : 'Logout';
                        saveSenders(senders);
                    }
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    await bot.sendMessage(userId, `❌ <b>WhatsApp terputus!</b>\n\nGunakan menu <b>ADD WA</b> untuk reconnect.`, { parse_mode: 'HTML' }).catch(() => {});
                } else {
                    userPairingState.set(String(userId), 'reconnecting');
                    setTimeout(() => startWASession(userId), 5000);
                }
            }
        });
        return sock;
    } catch (e) {
        console.error(`Error session ${userId}:`, e);
        return null;
    }
}

async function pairWhatsApp(userId, phoneNumber) {
    try {
        cleanPhone = phoneNumber.toString().replace(/[^0-9]/g, '');
        if (cleanPhone.length < 10) return { success: false, error: 'Nomor tidak valid (min 10 digit).' };
        const sessionPath = path.join(SESSIONS_DIR, String(userId));
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        userSessions.delete(String(userId));
        userPairingState.delete(String(userId));
        userPairingState.delete(String(userId) + '_notified');
        console.log(`📱 Pairing ${userId}, no: ${cleanPhone}`);
        const sock = await startWASession(userId);
        if (!sock) return { success: false, error: '❌ Gagal mulai session WhatsApp.' };
        await delay(3000);
        const code = await sock.requestPairingCode(cleanPhone);
        console.log(`✅ Pairing code ${userId}: ${code}`);
        userPairingState.set(String(userId), 'pairing');
        return { success: true, code, message: `╭━━━〔 📱 PAIRING WHATSAPP 〕━━━╮\n│\n├─ Kode: <code>${code}</code>\n├─ Masukkan di WhatsApp Web ponsel.\n│\n╰━━━〔 ⏳ Tunggu hingga terhubung 〕━━━╯` };
    } catch (e) {
        console.error(`❌ Pairing error ${userId}:`, e);
        const sessionPath = path.join(SESSIONS_DIR, String(userId));
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        userSessions.delete(String(userId));
        userPairingState.delete(String(userId));
        userPairingState.delete(String(userId) + '_notified');
        let errorMsg = e.message;
        if (errorMsg.includes('405') || errorMsg.includes('not registered')) errorMsg = '❌ Nomor tidak valid / tidak terdaftar.';
        else if (errorMsg.includes('timeout')) errorMsg = '⏳ Koneksi timeout.';
        else if (errorMsg.includes('closed')) errorMsg = '❌ Koneksi ditutup.';
        return { success: false, error: errorMsg };
    }
}

async function deleteWASession(userId) {
    const sessionPath = path.join(SESSIONS_DIR, String(userId));
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    userSessions.delete(String(userId));
    userPairingState.delete(String(userId));
    userPairingState.delete(String(userId) + '_notified');
    removeSender(userId);
    return { success: true };
}

function getJamPercentage(bio, setAt, metaBusiness) {
    let base = 50;
    if (bio && bio.length > 0) {
        if (bio.length > 100) base -= 20;
        else if (bio.length > 50) base -= 15;
        else if (bio.length > 20) base -= 10;
        else base -= 5;
    } else base += 15;
    if (setAt) {
        const diffDays = Math.ceil(Math.abs(Date.now() - new Date(setAt).getTime()) / 86400000);
        if (diffDays < 30) base -= 20;
        else if (diffDays < 90) base -= 10;
        else if (diffDays > 730) base += 25;
        else if (diffDays > 365) base += 15;
    } else base += 10;
    if (metaBusiness) base -= 25;
    base = Math.max(10, Math.min(90, base));
    return Math.round(base / 10) * 10;
}

async function checkWhatsAppBio(userId, phoneNumber, useGlobal = false) {
    try {
        const userIdStr = String(userId);
        let sock;
        if (useGlobal) {
            const globalSender = getSenderGlobal();
            if (!globalSender) return { registered: false, name: null, bio: null, error: '❌ Tidak ada sender global aktif.', accountType: 'not_registered', isAiAgent: false, isVerified: false };
            sock = userSessions.get(String(globalSender.userId));
            if (!sock) {
                sock = await startWASession(parseInt(globalSender.userId));
                if (!sock) return { registered: false, name: null, bio: null, error: '❌ Sender global tidak tersedia.', accountType: 'not_registered', isAiAgent: false, isVerified: false };
                await delay(3000);
            }
        } else {
            sock = userSessions.get(userIdStr);
            const status = userPairingState.get(userIdStr);
            if (!sock || status === 'disconnected' || status === 'reconnecting') {
                sock = await startWASession(userId);
                if (!sock) return { registered: false, name: null, bio: null, error: '❌ WhatsApp tidak terhubung.', accountType: 'not_registered', isAiAgent: false, isVerified: false };
                await delay(3000);
            }
            if (status !== 'connected' && status !== 'pairing') return { registered: false, name: null, bio: null, error: '⏳ WhatsApp sedang menghubungkan...', accountType: 'not_registered', isAiAgent: false, isVerified: false };
        }

        const cleanNum = String(phoneNumber).replace(/[^0-9]/g, '');
        const exists = await sock.onWhatsApp(cleanNum);
        const waInfo = exists?.[0];
        if (!waInfo?.exists) {
            return { registered: false, name: null, bio: null, jid: null, accountType: 'not_registered', isAiAgent: false, isVerified: false };
        }

        const jidResult = waInfo.jid || `${cleanNum}@s.whatsapp.net`;
        let bizData = {};
        if (waInfo.bizData && typeof waInfo.bizData === 'object') bizData = { ...waInfo.bizData };
        if (typeof sock.getBusinessProfile === 'function') {
            try {
                const bp = await sock.getBusinessProfile(jidResult);
                if (bp && typeof bp === 'object') bizData = { ...bizData, ...bp };
            } catch (e) {}
        }

        let name = null, bio = null, setAt = null;
        try {
            if (typeof sock.getProfile === 'function') {
                const profile = await sock.getProfile(jidResult);
                if (profile) {
                    name = profile.name || profile.pushName || null;
                    bio = profile.bio || profile.status || null;
                }
            }
        } catch (e) {}
        try {
            if (typeof sock.fetchStatus === 'function') {
                const statusData = await sock.fetchStatus(jidResult);
                const st = statusData?.[0]?.status;
                if (st) {
                    bio = st.status || bio || '';
                    setAt = st.setAt ? new Date(st.setAt) : null;
                }
            }
        } catch (e) {}

        const businessKeys = ['verifiedName','description','category','website','email','address','businessHours','business_hours','businessProfile','business_profile','isBusiness'];
        const hasBusinessMetadata = businessKeys.some(key => bizData[key] !== undefined && bizData[key] !== null && bizData[key] !== false && String(bizData[key]).trim() !== '');
        const isBusiness = !!(waInfo.bizData || hasBusinessMetadata);
        const jidLower = String(jidResult).toLowerCase();
        const aiMetadata = [waInfo.isBot, waInfo.isAiAgent, waInfo.aiAgent, waInfo.ai_agent, waInfo.isAI, waInfo.is_ai, bizData.isBot, bizData.is_bot, bizData.isAi, bizData.isAI, bizData.isAiAgent, bizData.aiAgent, bizData.ai_agent, bizData.metaAi, bizData.meta_ai, bizData.botType];
        const hasExplicitAiMetadata = aiMetadata.some(v => v === true || (typeof v === 'string' && /^(true|ai|bot|agent|meta.?ai)$/i.test(v.trim())));
        const metaText = JSON.stringify({ waInfo, bizData }).toLowerCase();
        const explicitAiText = /\b(meta\s*ai|metaai|ai\s*agent|ai\s*assistant|bot\s*account|automated\s*agent)\b/i.test(metaText);
        const isAiAgent = !!(jidLower.endsWith('@bot') || hasExplicitAiMetadata || explicitAiText);
        const verificationLevel = waInfo.verifiedLevel ?? bizData.verifiedLevel ?? bizData.verified_level ?? null;
        const isVerified = waInfo.isVerified === true || bizData.isVerified === true || bizData.is_verified === true || (typeof verificationLevel === 'string' && /verified|business/i.test(verificationLevel));
        const metaBusiness = isBusiness;

        return {
            registered: true,
            name,
            bio: bio || '',
            setAt,
            metaBusiness,
            jamPercentage: getJamPercentage(bio || '', setAt, metaBusiness),
            jid: jidResult,
            accountType: isBusiness ? 'business' : 'personal',
            isAiAgent,
            isVerified,
            verificationLevel: verificationLevel || null
        };
    } catch (e) {
        return { registered: false, name: null, bio: null, setAt: null, metaBusiness: false, error: e.message, accountType: 'not_registered', isAiAgent: false, isVerified: false };
    }
}

async function checkMultipleNumbers(userId, numbers, useGlobal = false, progressMessage = null, sourceLabel = 'Nomor') {
    const results = [];
    const batchSize = 10;

    for (let i = 0; i < numbers.length; i += batchSize) {
        if (cekBioStopState.get(String(userId))) break;

        const batch = numbers.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (num) => {
            try {
                const result = await checkWhatsAppBio(userId, num, useGlobal);
                return { number: num, ...result };
            } catch (e) {
                return { number: num, registered: false, error: e.message };
            }
        }));

        results.push(...batchResults);
    }

    return results;
}

function getSenderStatus(userId) {
    return userPairingState.get(String(userId)) || 'disconnected';
}

// ============================================================
// SERVER 2 / V2 — Basha
// ============================================================
function resolveStockCountryCode(fileName) {
    const base = String(fileName || '').replace(/\.txt$/i, '').trim();
    if (!base) return '';

    // Cari nama negara di seluruh nama file, bukan hanya bagian pertama.
    // Contoh: Im-Ecuador-Black.txt -> EC, bukan IM.
    const parts = base.split(/[-_\s]+/).filter(Boolean);
    let fallback = '';

    for (const part of parts) {
        const token = String(part).trim();
        if (!token) continue;
        const code = getCountryCodeFromName(token);
        if (!code) continue;

        // Kode 2 huruf dipakai sebagai fallback; nama negara lengkap
        // diberi prioritas agar prefix seperti "Im-" tidak salah dibaca.
        if (token.length > 2) return code;
        if (!fallback) fallback = code;
    }

    const whole = getCountryCodeFromName(base);
    return whole || fallback;
}

function consolidateCountryFiles(dir, countryCode) {
    if (!fs.existsSync(dir) || !countryCode) return null;

    const files = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.txt'))
        .filter(f => resolveStockCountryCode(f) === countryCode);

    if (!files.length) return null;

    const all = [];
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            all.push(...(content.match(/\d{9,15}/g) || []));
        } catch (e) {}
    }

    const unique = [...new Set(all)];
    const canonical = path.join(dir, `${countryCode}.txt`);

    fs.writeFileSync(canonical, unique.join('\n'), 'utf8');

    for (const file of files) {
        const fp = path.join(dir, file);
        if (path.resolve(fp) !== path.resolve(canonical) && fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); } catch (e) {}
        }
    }

    return canonical;
}

function getStockCountryInfo(fileName) {
    const code = resolveStockCountryCode(fileName);
    return { code, name: getCountryName(code), flag: getCountryFlag(code) };
}

function getAllCountriesFromDir(dir) {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.txt'));
    const grouped = new Map();

    for (const file of files) {
        const code = resolveStockCountryCode(file);
        if (!code) continue;

        let stock = 0;
        try {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            stock = (content.match(/\d{9,15}/g) || []).length;
        } catch (e) {}

        if (!grouped.has(code)) {
            grouped.set(code, {
                code,
                name: getCountryName(code),
                flag: getCountryFlag(code),
                files: [],
                stock: 0
            });
        }

        const item = grouped.get(code);
        item.files.push(file);
        item.stock += stock;
    }

    return [...grouped.values()].filter(x => x.stock > 0);
}

function showServerMenu(chatId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: '🟢 SERVER V1', callback_data: 'get_server:v1' }],
            [{ text: '🔵 SERVER V2', callback_data: 'get_server:v2' }]
        ]
    };
    sendClean(chatId, '📱 <b>PILIH SERVER GET NUMBER</b>\n\n🟢 V1 = stok Server 1\n🔵 V2 = stok Server 2\nNOTE: UNTUK SERVER 2 OTP DI GRUP YA\nMETODE V2: GUNAKAN BAHASA INGGRIS', {
        parse_mode: 'HTML', reply_markup: keyboard
    });
}

function showCountryMenuV2(chatId, messageId) {
    const countries = getAllCountriesFromDir(DATA_V2_DIR);
    if (countries.length === 0) return sendBQ(chatId, '📂 Stok V2 kosong.');
    const keyboard = [];
    for (let i = 0; i < countries.length; i += 2) {
        const makeButton = c => ({
            text: `${c.flag} ${c.name} — ${c.stock.toLocaleString('id-ID')} nomor`,
            callback_data: `sel_country_v2:${c.code.toLowerCase()}`
        });
        const row = [makeButton(countries[i])];
        if (countries[i + 1]) row.push(makeButton(countries[i + 1]));
        keyboard.push(row);
    }
    keyboard.push([{ text: '⬅️ PILIH SERVER', callback_data: 'get_number_menu' }]);
    const opts = { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    if (messageId) bot.editMessageText('🌍 <b>PILIH NEGARA — SERVER V2</b>', opts).catch(() => {});
    else sendClean(chatId, '🌍 <b>PILIH NEGARA — SERVER V2</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showNumbersV2(q, country) {
    if (!q.message) return;
    const { chat, message_id } = q.message;
    const userId = q.from.id;
    const countryCode = getCountryCodeFromName(country);
    const actualFilePath = consolidateCountryFiles(DATA_V2_DIR, countryCode);

    if (!actualFilePath || !fs.existsSync(actualFilePath)) {
        return bot.answerCallbackQuery(q.id, { text: '❌ Stok V2 tidak tersedia!', show_alert: true });
    }

    let nums = fs.readFileSync(actualFilePath, 'utf8')
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);

    if (!nums.length) {
        try { fs.unlinkSync(actualFilePath); } catch (_) {}
        return bot.answerCallbackQuery(q.id, { text: '❌ Stok V2 habis!', show_alert: true });
    }

    const selected = [];
    for (let i = 0; i < Math.min(GET_NUMBER_BATCH_SIZE, nums.length); i++) {
        const idx = Math.floor(Math.random() * nums.length);
        const num = nums[idx].replace(/[^0-9]/g, '');
        if (num) {
            selected.push(num);
            takenNumbersV2.set(num, { chatId: chat.id, countryCode });
        }
        nums.splice(idx, 1);
    }

    fs.writeFileSync(actualFilePath, nums.join('\n'), 'utf8');
    if (!nums.length) {
        try { fs.unlinkSync(actualFilePath); } catch (_) {}
    }

    const isPremiumUser = isPremium(userId);
    const flag = getCountryFlag(countryCode);
    const countryName = getCountryName(countryCode);
    updateUserStats(userId, 'get_number');

    const personalConnected = getSenderStatus(userId) === 'connected' && userSessions.has(String(userId));
    const globalAvailable = isPremiumUser && getSenderGlobal();
    const autoCheck = Boolean(globalAvailable || personalConnected);

    let results = selected.map(number => ({
        number,
        registered: false,
        accountType: 'not_registered',
        isAiAgent: false,
        isVerified: false
    }));

    if (autoCheck) {
        results = await checkMultipleNumbers(
            userId,
            selected,
            Boolean(globalAvailable),
            null,
            'Nomor V2'
        );
        recordCheckResults(results);
        updateUserStats(userId, 'cek_bio');
    }

    let text = `🔵 <b>NOMOR V2 ${countryName} ${flag}</b>\n`;
    text += isPremiumUser ? `👑 <b>PREMIUM USER</b>\n\n` : `👤 <b>FREE USER</b>\n\n`;

    if (autoCheck) {
        text += `⚙️ <b>CEK BIO SELESAI</b>\n`;
        text += `▰▰▰▰▰▰▰▰▰▰\n\n`;
        text += `📦 <b>Sisa Nomor:</b> ${nums.length}\n\n`;
        text += `<b>INFORMASI DETEKSI</b>\n`;
        text += `HIJAU: TERDAFTAR BISNIS\n`;
        text += `BIRU : TERDAFTAR BIASA\n`;
        text += `MERAH: TIDAK TERDAFTAR\n`;
    } else if (isPremiumUser) {
        text += `⚠️ <b>Sender Global belum tersedia!</b>\n\n`;
        text += `📦 <b>Sisa Nomor:</b> ${nums.length}\n\n`;
        text += `📋 <b>SALIN SEMUA NOMOR</b>`;
    } else {
        text += `💡 <i>Fitur Cek Bio menggunakan Sender Global atau Sender Sendiri.</i>\n`;
        text += `Pilih tombol di bawah untuk menggunakan sender.\n\n`;
        text += `📦 <b>Sisa Nomor:</b> ${nums.length}`;
    }

    const kb = [];
    kb.push([{ text: '📋 SALIN SEMUA', copy_text: { text: selected.map(n => '+' + n).join('\n') } }]);
    kb.push([
        { text: '🔍 CEK WA BIASA', callback_data: `filter_bio_v2:personal:${countryCode.toLowerCase()}` },
        { text: '💼 CEK WA BISNIS', callback_data: `filter_bio_v2:business:${countryCode.toLowerCase()}` }
    ]);

    if (autoCheck) {
        results.forEach(r => {
            let style = 'danger';
            if (r.registered) style = r.accountType === 'business' ? 'success' : 'primary';
            const aiMark = r.isAiAgent ? ' 🤖' : '';
            kb.push([{ text: `+${r.number}${aiMark}`, copy_text: { text: '+' + r.number }, style }]);
        });
    } else {
        selected.forEach(num => kb.push([{ text: `+${num}`, copy_text: { text: '+' + num } }]));
    }

    kb.push([
        { text: '🔄 GANTI NOMOR', callback_data: `sel_country_v2:${countryCode.toLowerCase()}` },
        { text: '🌍 GANTI SERVER', callback_data: 'get_number_menu' }
    ]);
    kb.push([
        { text: '🌐 SENDER GLOBAL', callback_data: 'sender_global' },
        { text: '📱 SENDER SENDIRI', callback_data: 'sender_personal' }
    ]);
    kb.push([
        { text: '➕ ADD WA', callback_data: 'add_wa_menu' },
        { text: '🔑 GRUP OTP', url: settings.GROUP_OTP_LINK }
    ]);

    try {
        await bot.editMessageText(text, {
            chat_id: chat.id,
            message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: kb }
        });
    } catch (_) {
        await bot.deleteMessage(chat.id, message_id).catch(() => {});
        await bot.sendMessage(chat.id, text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: kb }
        }).catch(() => {});
    }

    await bot.answerCallbackQuery(q.id, {
        text: autoCheck ? `✅ ${selected.length} nomor V2 selesai dicek` : `✅ ${selected.length} nomor V2 diambil`
    }).catch(() => {});
}

// ============================================================
// CHECK BASHA V2 (format sama seperti V1)
// ============================================================
async function checkBashaOtpV2() {
    if (!getOtpControl().v2) return;
    const token = String(settings.BASHA_API_KEY || '').trim();
    if (!token || token === 'ISI_TOKEN_BASHA_DI_SINI') return;
    for (const [num, allocation] of [...takenNumbersV2.entries()]) {
        const chatId = typeof allocation === 'object' ? allocation.chatId : allocation;
        const allocatedCountry = typeof allocation === 'object' ? allocation.countryCode : '';
        try {
            const { data } = await axios.post(
                settings.BASHA_API_URL || 'https://basha.cc/api/legacy/get-last-sms',
                { number: num, limit: 1 },
                { headers: { 'X-Api-Key': token, 'Content-Type': 'application/json' }, timeout: 8000 }
            );
            if (!data || data.status !== 'ok') continue;
            const messages = Array.isArray(data.messages) ? data.messages : [data];
            const msg = messages[0] || data;
            const raw = String(msg.text || msg.pesan_teks || msg.message || msg.teks_pesan || '');
            const otp = extractOtpSmart(raw);
            if (!otp || otp === '-') continue;

            const source = String(msg.source_number || msg.nomor_sumber || msg.source || 'Basha');
            const cleanNum = String(num).replace(/\D/g, '');
            const country = allocatedCountry || detectCountryFromNumber(cleanNum) || 'UNKNOWN';
            const key = `v2_${cleanNum}_${otp}`;
            if (seen_otps.has(key)) continue;
            seen_otps.add(key);

            saveOtpHistory({ number: cleanNum, otp, app: source, country, message: raw, server: 'V2' });

            // === GACHA V2 → user (format sama dengan V1) ===
            const gachaText = `🎰 <b>GACHA OTP BERHASIL!</b>\n\n📱 <b>App:</b> ${escapeHtmlV1(source)}\n🔢 <b>No:</b> +${cleanNum}\n🔑 <b>OTP:</b> <code>${otp}</code>`;
            await bot.sendMessage(chatId, gachaText, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "📋 COPY OTP", copy_text: { text: String(otp) }, style: "success" }]] }
            }).catch(() => {});

            // === KIRIM KE GRUP V2 (format sama dengan V1) ===
            sendToGroupsV2(cleanNum, otp, source, raw, country);

            takenNumbersV2.delete(num);
        } catch (e) {
            if (e.response?.status !== 404 && e.response?.status !== 401) {
                console.error('Basha V2 polling error:', e.message);
            }
        }
    }
}

// ============================================================
// SHOW NUMBERS (GET NUMBER — Server 1)
// ============================================================
async function showNumbers(q, country) {
    if (!q.message) return;
    const { chat, message_id } = q.message;
    const userId = q.from.id;
    const countryCode = getCountryCodeFromName(country);

    const actualFilePath = consolidateCountryFiles(DATA_DIR, countryCode);

    if (!actualFilePath || !fs.existsSync(actualFilePath)) {
        return bot.answerCallbackQuery(q.id, { text: "❌ Data sudah tidak tersedia!", show_alert: true });
    }

    let nums = fs.readFileSync(actualFilePath, 'utf8')
        .split(/\r?\n/)
        .map(n => n.trim())
        .filter(Boolean);

    if (nums.length === 0) {
        try { fs.unlinkSync(actualFilePath); } catch (_) {}
        await bot.editMessageText(`❌ Stok <b>${getCountryName(countryCode)}</b> habis. File telah dihapus.`, {
            chat_id: chat.id, message_id, parse_mode: 'HTML'
        });
        return bot.answerCallbackQuery(q.id, { text: "Stok habis!" });
    }

    const selected = [];
    for (let i = 0; i < Math.min(GET_NUMBER_BATCH_SIZE, nums.length); i++) {
        const idx = Math.floor(Math.random() * nums.length);
        const num = nums[idx].replace(/[^0-9]/g, '');
        selected.push(num);
        takenNumbers.set(num, chat.id);
        nums.splice(idx, 1);
    }
    fs.writeFileSync(actualFilePath, nums.join('\n'), 'utf8');

    const isPremiumUser = isPremium(userId);
    const flag = getCountryFlag(countryCode);
    const countryName = getCountryName(countryCode);
    updateUserStats(userId, 'get_number');

    let results = selected.map(number => ({ number, registered: false, accountType: 'not_registered', isAiAgent: false }));
    const personalConnected = getSenderStatus(userId) === 'connected' && userSessions.has(String(userId));
    const globalAvailable = isPremiumUser && getSenderGlobal();
    const autoCheck = Boolean(globalAvailable || personalConnected);

    if (autoCheck) {
        results = await checkMultipleNumbers(userId, selected, Boolean(globalAvailable), null, 'Nomor');
        recordCheckResults(results);
        updateUserStats(userId, 'cek_bio');
    }

    let text = `📱 <b>NOMOR ${countryName} ${flag}</b>\n`;
    text += isPremiumUser ? `👑 <b>PREMIUM USER</b>\n\n` : `👤 <b>FREE USER</b>\n\n`;
    if (autoCheck) {
        text += `⚙️ <b>CEK BIO SELESAI</b>\n\n`;
        text += `📦 <b>Sisa Nomor:</b> ${nums.length}\n\n`;
        text += `<b>INFORMASI DETEKSI</b>\nHIJAU: TERDAFTAR BINIS\nBIRU : TERDAFTAR BIASA\nMERAH: TIDAK TERDAFTAR\n`;
    } else if (isPremiumUser) {
        text += `⚠️ <b>Sender Global belum tersedia!</b>\n\n📦 <b>Sisa Nomor:</b> ${nums.length}\n\n📋 <b>SALIN SEMUA NOMOR</b>`;
    } else {
        text += `💡 <i>Fitur Cek Bio menggunakan Sender Global</i>\n<i>Pilih tombol di bawah untuk menggunakan Sender Global</i>\n\n📦 <b>Sisa Nomor:</b> ${nums.length}`;
    }

    const kb = [];
    kb.push([{ text: "📋 SALIN SEMUA", copy_text: { text: selected.map(n => '+' + n).join('\n') } }]);
    kb.push([
        { text: "🔍 CEK WA BIASA", callback_data: `filter_bio:personal:${countryCode.toLowerCase()}` },
        { text: "💼 CEK WA BISNIS", callback_data: `filter_bio:business:${countryCode.toLowerCase()}` }
    ]);

    if (autoCheck) {
        results.forEach(r => {
            let style = 'danger';
            if (r.registered) style = r.accountType === 'business' ? 'success' : 'primary';
            const aiMark = r.isAiAgent ? ' 🤖' : '';
            kb.push([{ text: `+${r.number}${aiMark}`, copy_text: { text: '+' + r.number }, style }]);
        });
    } else {
        selected.forEach(num => kb.push([{ text: `+${num}`, copy_text: { text: '+' + num } }]));
    }

    kb.push([
        { text: "🔄 GANTI NOMOR", callback_data: `sel_country:${countryCode.toLowerCase()}` },
        { text: "🌍 GANTI NEGARA", callback_data: "change_range" }
    ]);
    kb.push([{ text: "🌐 SENDER GLOBAL", callback_data: "sender_global" }, { text: "📱 SENDER SENDIRI", callback_data: "sender_personal" }]);
    kb.push([{ text: "➕ ADD WA", callback_data: "add_wa_menu" }, { text: "🔑 GRUP OTP", url: settings.GROUP_OTP_LINK }]);

    try {
        await bot.editMessageText(text, { chat_id: chat.id, message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
        await bot.deleteMessage(chat.id, message_id).catch(() => {});
        await bot.sendMessage(chat.id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }
    bot.answerCallbackQuery(q.id).catch(() => {});
}

// ============================================================
// HANDLE SENDER GLOBAL (FREE USER)
// ============================================================
async function handleSenderGlobal(q) {
    const userId = q.from.id;
    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;

    if (isPremium(userId)) {
        await bot.answerCallbackQuery(q.id, { text: "✅ Anda sudah premium!" });
        return;
    }

    const globalSender = getSenderGlobal();
    if (!globalSender) {
        await bot.editMessageText(
            `❌ <b>Sender Global belum tersedia!</b>\n\n💡 Sender Global adalah WhatsApp yang dipakai bersama.\nSaat ini belum ada user yang menghubungkan WhatsApp.\n\n📱 Cara menambahkan:\n1. Klik tombol <b>➕ ADD WA</b>\n2. Masukkan nomor WhatsApp\n3. Pairing kode\n4. Otomatis jadi Sender Global`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
        );
        await bot.answerCallbackQuery(q.id);
        return;
    }

    const quota = getUserQuota(userId);
    const totalQuota = getTotalQuota();
    if (quota.count >= totalQuota) {
        const priceText = `╭━━━〔 💎 BOT PREMIUM 〕━━━╮\n┃\n┃ 🗓️ 2 Hari  — 1K\n┃ 🗓️ 4 Hari  — 2K\n┃ 🗓️ 6 Hari  — 3K\n┃ 🗓️ 8 Hari  — 4K\n┃ 🗓️ 10 Hari — 5K\n┃ 🗓️ 12 Hari — 6K\n┃ 🗓️ 14 Hari — 7K\n┃ 🗓️ 16 Hari — 8K\n┃ 🗓️ 18 Hari — 9K\n┃ 🗓️ 20 Hari — 10K\n┃ 🗓️ 22 Hari — 11K\n┃ 🗓️ 24 Hari — 12K\n┃ 🗓️ 26 Hari — 13K\n┃ 🗓️ 28 Hari — 14K\n┃ 🗓️ 30 Hari — 15K\n┃\n┃ ⭐ 2 Bulan — 30K\n┃ 👑 3 Bulan — 45K\n┃\n╰━━━━━━━━━━━━━━━━━━╯\n\n📩 MINAT? CHAT ADMIN: @orvinznokos`;

        await bot.editMessageText(
            `❌ Maaf, kuota gratis Sender Global hari ini sudah habis!\n\n📊 Detail:\n📅 Hari ini: ${new Date().toLocaleDateString('id-ID')}\n✅ Sudah digunakan: ${quota.count}x\n❌ Sisa kuota: 0x\n\n💡 Solusi:\n1️⃣ Gunakan SENDER SENDIRI (pakai WA sendiri)\n2️⃣ Beli PREMIUM untuk kuota tidak terbatas\n\n💰 Harga Premium:\n${priceText}`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
        );
        await bot.answerCallbackQuery(q.id);
        return;
    }

    quota.count++;
    saveUserQuota(userId, quota);
    await bot.answerCallbackQuery(q.id, { text: `✅ Menggunakan Sender Global (sisa ${totalQuota - quota.count}x lagi)` });

    const session = userSession.get(chatId);
    const country = session?.selectedCountry || 'togo';
    const filePath = path.join(DATA_DIR, `${country}.txt`);
    if (!fs.existsSync(filePath)) {
        await bot.sendMessage(chatId, "❌ File tidak ditemukan.");
        return;
    }
    let nums = fs.readFileSync(filePath, 'utf8').split('\n').filter(n => n.trim());
    const selected = [];
    for (let i = 0; i < Math.min(GET_NUMBER_BATCH_SIZE, nums.length); i++) {
        const idx = Math.floor(Math.random() * nums.length);
        selected.push(nums[idx].replace(/[^0-9]/g, ''));
        nums.splice(idx, 1);
    }
    fs.writeFileSync(filePath, nums.join('\n'), 'utf8');

    const flag = getCountryFlag(country);
    const countryName = getCountryName(country);

    let text = `📱 <b>NOMOR ${countryName} ${flag}</b>\n`;
    text += `👤 <b>FREE USER</b>\n\n`;
    text += `⚙️ <b>CEK BIO SELESAI</b>\n`;
    text += `▰▰▰▰▰▰▰▰▰▰\n\n`;
    text += `💡 Sisa kuota Sender Global hari ini: <b>${totalQuota - quota.count}x</b> lagi\n`;
    text += `📦 <b>Sisa Nomor:</b> ${nums.length}\n\n`;
    text += `📋 <b>SALIN SEMUA NOMOR</b>\n\n`;
    const results = await checkMultipleNumbers(userId, selected, true, null, 'Nomor');
    cekBioStopState.delete(String(userId));
    recordCheckResults(results);
    results.forEach((r) => {
        const icon = r.registered ? '✅' : '❌';
        const name = r.registered && r.name ? ` | ${r.name}` : '';
        text += `${icon} +${r.number}${name}\n`;
    });
    updateUserStats(userId, 'cek_bio');

    const kb = [];
    kb.push([{ text: "📋 SALIN SEMUA", copy_text: { text: selected.map(n => '+' + n).join('\n') } }]);
    results.forEach((r) => {
        const style = r.registered ? 'success' : 'danger';
        const icon = r.registered ? '✅' : '❌';
        const name = r.registered && r.name ? ` | ${r.name}` : '';
        kb.push([{ text: `${icon} +${r.number}${name}`, copy_text: { text: '+' + r.number }, style: style }]);
    });
    kb.push([
        { text: "🔄 GANTI NOMOR", callback_data: `sel_country:${country}` },
        { text: "🌍 GANTI NEGARA", callback_data: "change_range" }
    ]);
    kb.push([
        { text: "🌐 SENDER GLOBAL", callback_data: "sender_global" },
        { text: "📱 SENDER SENDIRI", callback_data: "sender_personal" }
    ]);
    kb.push([
        { text: "➕ ADD WA", callback_data: "add_wa_menu" },
        { text: "🔑 GRUP OTP", url: settings.GROUP_OTP_LINK }
    ]);

    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
}

// ============================================================
// HANDLE SENDER PERSONAL
// ============================================================
async function handleSenderPersonal(q) {
    const userId = q.from.id;
    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;

    const status = getSenderStatus(userId);
    if (status !== 'connected') {
        await bot.editMessageText(
            `❌ Anda belum menghubungkan WhatsApp sendiri.\n\nSilakan gunakan:\n✅ SENDER GLOBAL (Premium) → atau\n✅ ADD WA (Personal) untuk menghubungkan WA sendiri\n\n📱 Klik tombol ADD WA di bawah untuk menghubungkan.`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
        );
        await bot.answerCallbackQuery(q.id);
        return;
    }

    await bot.answerCallbackQuery(q.id, { text: "✅ Menggunakan Sender Sendiri" });

    const session = userSession.get(chatId);
    const country = session?.selectedCountry || 'togo';
    const filePath = path.join(DATA_DIR, `${country}.txt`);
    if (!fs.existsSync(filePath)) {
        await bot.sendMessage(chatId, "❌ File tidak ditemukan.");
        return;
    }
    let nums = fs.readFileSync(filePath, 'utf8').split('\n').filter(n => n.trim());
    const selected = [];
    for (let i = 0; i < Math.min(GET_NUMBER_BATCH_SIZE, nums.length); i++) {
        const idx = Math.floor(Math.random() * nums.length);
        selected.push(nums[idx].replace(/[^0-9]/g, ''));
        nums.splice(idx, 1);
    }
    fs.writeFileSync(filePath, nums.join('\n'), 'utf8');

    const flag = getCountryFlag(country);
    const countryName = getCountryName(country);
    const isPremiumUser = isPremium(userId);

    let text = `📱 <b>NOMOR ${countryName} ${flag}</b>\n`;
    if (isPremiumUser) {
        text += `👑 <b>PREMIUM USER</b>\n\n`;
    } else {
        text += `👤 <b>FREE USER</b>\n\n`;
    }
    text += `⚙️ <b>CEK BIO SELESAI</b>\n`;
    text += `▰▰▰▰▰▰▰▰▰▰\n\n`;
    text += `📦 <b>Sisa Nomor:</b> ${nums.length}\n\n`;
    text += `📋 <b>SALIN SEMUA NOMOR</b>\n\n`;
    const results = await checkMultipleNumbers(userId, selected, false, null, 'Nomor');
    cekBioStopState.delete(String(userId));
    recordCheckResults(results);
    results.forEach((r) => {
        const icon = r.registered ? '✅' : '❌';
        const name = r.registered && r.name ? ` | ${r.name}` : '';
        text += `${icon} +${r.number}${name}\n`;
    });
    updateUserStats(userId, 'cek_bio');

    const kb = [];
    kb.push([{ text: "📋 SALIN SEMUA", copy_text: { text: selected.map(n => '+' + n).join('\n') } }]);
    results.forEach((r) => {
        const style = r.registered ? 'success' : 'danger';
        const icon = r.registered ? '✅' : '❌';
        const name = r.registered && r.name ? ` | ${r.name}` : '';
        kb.push([{ text: `${icon} +${r.number}${name}`, copy_text: { text: '+' + r.number }, style: style }]);
    });
    kb.push([
        { text: "🔄 GANTI NOMOR", callback_data: `sel_country:${country}` },
        { text: "🌍 GANTI NEGARA", callback_data: "change_range" }
    ]);
    if (!isPremiumUser) {
        kb.push([
            { text: "🌐 SENDER GLOBAL", callback_data: "sender_global" },
            { text: "📱 SENDER SENDIRI", callback_data: "sender_personal" }
        ]);
    } else {
        kb.push([{ text: "📱 SENDER SENDIRI", callback_data: "sender_personal" }]);
    }
    kb.push([
        { text: "➕ ADD WA", callback_data: "add_wa_menu" },
        { text: "🔑 GRUP OTP", url: settings.GROUP_OTP_LINK }
    ]);

    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
}

// ============================================================
// NOTIF UPLOAD STOK
// ============================================================
const pendingStokNotif = [];
let stokNotifTimer = null;

function formatUploadNotif(flag, countryName, count) {
    return `✅ 𝗦𝗨𝗞𝗦𝗘𝗦 𝗠𝗘𝗡𝗔𝗠𝗕𝗔𝗛𝗞𝗔𝗡 𝗡𝗢𝗠𝗢𝗥 𝗨𝗡𝗧𝗨𝗞 ${flag} ${countryName}\n📦 𝗧𝗢𝗧𝗔𝗟: ${count} 𝗡𝗢𝗠𝗢𝗥.`;
}

function sendUploadNotif(country, total) {
    let code = country.toUpperCase();
    if (code.length > 2) {
        const mapped = getCountryCodeFromName(country);
        if (mapped && mapped.length === 2) code = mapped;
    }
    pendingStokNotif.push({ flag: getCountryFlag(code), name: getCountryName(country), total });
    if (!stokNotifTimer) {
        stokNotifTimer = setTimeout(async () => {
            stokNotifTimer = null;
            if (pendingStokNotif.length === 0) return;
            const items = pendingStokNotif.splice(0, pendingStokNotif.length);
            const lines = items.map(it => formatUploadNotif(it.flag, it.name, it.total));
            const text = lines.join('\n\n') + '\n\nBURUAN CEK MUMPUNG MASIH FRESH DAN GA NGEJAM';
            const keyboard = { inline_keyboard: [[{ text: "📱 GET NUMBER", url: "https://t.me/smart_otp_v1_bot", style: "primary" }]] };
            if (settings.NOTIF_CHANNEL) await bot.sendMessage(settings.NOTIF_CHANNEL, text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
            await sendToOwners(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }, 1200);
    }
}

// ============================================================
// GET FILE (Server 1)
// ============================================================
async function handleGetFileMenu(chatId) {
    if (lastBotMessage.has(chatId)) {
        bot.deleteMessage(chatId, lastBotMessage.get(chatId)).catch(() => {});
        lastBotMessage.delete(chatId);
    }

    const keyboard = {
        inline_keyboard: [
            [{ text: '🟢 GET FILE V1', callback_data: 'get_file_server:v1' }],
            [{ text: '🔵 GET FILE V2', callback_data: 'get_file_server:v2' }],
            [{ text: '⬅️ KEMBALI', callback_data: 'admin_back_menu' }]
        ]
    };

    const sent = await bot.sendMessage(
        chatId,
        '<blockquote>📂 <b>PILIH SERVER GET FILE</b>\n\n🟢 V1 = stok Server 1\n🔵 V2 = stok Server 2 / Basha</blockquote>',
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
    lastBotMessage.set(chatId, sent.message_id);
}

async function showGetFileList(chatId, messageId, server) {
    const dir = server === 'v2' ? DATA_V2_DIR : DATA_DIR;
    const countries = server === 'v2' ? getAllCountriesFromDir(dir) : getAllCountries();

    if (!countries.length) {
        return bot.editMessageText(
            `<blockquote>📂 <b>GET FILE ${server.toUpperCase()}</b>\n\nStok ${server.toUpperCase()} kosong.</blockquote>`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'get_file_menu' }]] } }
        );
    }

    const keyboard = [];
    for (const c of countries) {
        keyboard.push([{
            text: `${c.flag} ${c.name} — ${c.stock.toLocaleString('id-ID')} nomor`,
            callback_data: `dl_file:${server}:${c.code.toLowerCase()}`
        }]);
    }
    keyboard.push([{ text: '⬅️ PILIH SERVER', callback_data: 'get_file_menu' }]);

    await bot.editMessageText(
        `<blockquote>📄 <b>DAFTAR FILE STOK — ${server.toUpperCase()}</b></blockquote>`,
        {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        }
    ).catch(() => {});
}

// ============================================================
// DELETE FILE MENU (Server 1)
// ============================================================
function showDeleteFileMenu(chatId, server = 'v1') {
    const normalizedServer = server === 'v2' ? 'v2' : 'v1';
    const dir = normalizedServer === 'v2' ? DATA_V2_DIR : DATA_DIR;
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.txt')) : [];
    if (files.length === 0) return sendBQ(chatId, `📂 Folder stok ${normalizedServer.toUpperCase()} kosong.`);
    const keyboard = [];
    files.forEach(file => {
        const code = getCountryCodeFromName(file.replace('.txt', '').toUpperCase());
        const count = (fs.readFileSync(path.join(dir, file), 'utf8').match(/\d{9,15}/g) || []).length;
        keyboard.push([{ text: `${getCountryFlag(code)} ${getCountryName(code)} — ${count} nomor`, callback_data: `del_file:${normalizedServer}:${file}` }]);
    });
    keyboard.push([{ text: '⬅️ PILIH SERVER', callback_data: 'del_select_server:file' }]);
    bot.sendMessage(chatId, `🗑️ <b>PILIH FILE STOK ${normalizedServer.toUpperCase()}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function handleDeleteAllStok(chatId, server = 'v1') {
    const normalizedServer = server === 'v2' ? 'v2' : 'v1';
    const dir = normalizedServer === 'v2' ? DATA_V2_DIR : DATA_DIR;
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.txt')) : [];
    if (files.length === 0) return sendBQ(chatId, `📂 Stok ${normalizedServer.toUpperCase()} sudah kosong.`);
    let text = `⚠️ <b>YAKIN INGIN MENGHAPUS SEMUA STOK ${normalizedServer.toUpperCase()}?</b>\n\n📂 ${files.length} file akan dihapus:\n`;
    files.forEach(file => {
        const country = file.replace('.txt', '').toUpperCase();
        text += `${getCountryFlag(country)} ${getCountryName(country)}\n`;
    });
    const keyboard = { inline_keyboard: [
        [{ text: '✅ YA, HAPUS SEMUA', callback_data: `confirm_del_all_stok:${normalizedServer}` }],
        [{ text: '❌ BATAL', callback_data: 'admin_back_menu' }]
    ] };
    sendBQ(chatId, text, { reply_markup: keyboard });
}

// ============================================================
// SHOW COUNTRY MENU (GET NUMBER)
// ============================================================
function showCountryMenu(chatId, messageId) {
    const countries = getAllCountries();
    if (countries.length === 0) return sendBQ(chatId, "📂 Folder data kosong.");
    const keyboard = [];
    for (let i = 0; i < countries.length; i += 2) {
        const makeButton = (c) => ({ text: `${c.flag} ${c.name} — ${c.stock.toLocaleString('id-ID')} nomor`, callback_data: `sel_country:${c.code.toLowerCase()}` });
        const row = [makeButton(countries[i])];
        if (countries[i + 1]) row.push(makeButton(countries[i + 1]));
        keyboard.push(row);
    }
    const text = "🌍 <b>PILIH NEGARA:</b>";
    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
    } else sendClean(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ============================================================
// TRAFFIC & VIEW ALL STOK
// ============================================================
async function handleTrafficCommand(chatId) {
    const waitMsg = await sendBQ(chatId, "🔄 <i>Sedang mengambil data traffic...</i>");
    try {
        const trafficData = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'));
        const daily = trafficData.daily || {};
        const sorted = Object.entries(daily).sort((a, b) => b[1] - a[1]);
        const total = sorted.reduce((sum, [_, count]) => sum + count, 0);
        let text = `📊 <b>LIVE TRAFFIC & OTP COUNT</b>\n━━━━━━━━━━━━━━━━━━━━━\n📅 <b>${new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</b>\n\n`;
        if (sorted.length === 0 || total === 0) {
            text += "<i>Belum ada data OTP hari ini.</i>";
        } else {
            sorted.slice(0, 10).forEach(([code, count], index) => {
                text += `${index + 1}. ${getCountryFlag(code)} ${getCountryName(code)} : <b>${count}</b> OTP\n`;
            });
            text += `\n📦 <b>Total: ${total} OTP</b>`;
        }
        const keyboard = { inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "refresh_traffic" }],
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]
        ] };
        await bot.editMessageText(text, { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML', reply_markup: keyboard });
    } catch (e) {
        await bot.editMessageText("⚠️ Gagal mengambil data traffic.", { chat_id: chatId, message_id: waitMsg.message_id });
    }
}

async function handleViewAllStok(chatId) {
    const readServerStock = (dir, server) => {
        if (!fs.existsSync(dir)) return { server, rows: [], total: 0 };
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
        const rows = [];
        let total = 0;
        files.forEach(file => {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            const count = (content.match(/\d{9,15}/g) || []).length;
            if (count <= 0) return;
            const country = file.replace('.txt', '').toUpperCase();
            rows.push({ country, count });
            total += count;
        });
        return { server, rows, total };
    };

    const v1 = readServerStock(DATA_DIR, 'V1');
    const v2 = readServerStock(DATA_V2_DIR, 'V2');
    if (v1.total === 0 && v2.total === 0) return sendBQ(chatId, "📂 Semua stok kosong.");

    let text = "📊 <b>LIST ALL STOK</b>\n━━━━━━━━━━━━━━━━━━━━━\n";
    text += `🟢 <b>V1 — SERVER 1</b>\n`;
    if (v1.rows.length) v1.rows.forEach(({ country, count }) => { text += `${getCountryFlag(country)} ${getCountryName(country)} : ${count} nomor\n`; });
    else text += `<i>Tidak ada stok V1.</i>\n`;
    text += `📦 Total V1: <b>${v1.total} nomor</b>\n\n`;

    text += `🔵 <b>V2 — SERVER 2 / BASHA</b>\n`;
    if (v2.rows.length) v2.rows.forEach(({ country, count }) => { text += `${getCountryFlag(country)} ${getCountryName(country)} : ${count} nomor\n`; });
    else text += `<i>Tidak ada stok V2.</i>\n`;
    text += `📦 Total V2: <b>${v2.total} nomor</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n📦 <b>Total Semua: ${v1.total + v2.total} nomor</b>`;

    const keyboard = { inline_keyboard: [[{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]] };
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ============================================================
// LIST OTP (kirim sebagai file TXT per negara)
// ============================================================
async function handleListOtpCountry(chatId, server = null) {
    if (!server) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🟢 LIST OTP V1', callback_data: 'otp_server:v1' }],
                [{ text: '🔵 LIST OTP V2', callback_data: 'otp_server:v2' }],
                [{ text: '⬅️ KEMBALI', callback_data: 'admin_back_menu' }]
            ]
        };
        return bot.sendMessage(chatId, '📋 <b>PILIH SERVER LIST OTP</b>\n\n🟢 V1 = OTP Server 1\n🔵 V2 = OTP Server 2 / Basha', {
            parse_mode: 'HTML', reply_markup: keyboard
        });
    }

    const normalizedServer = server.toUpperCase() === 'V2' ? 'V2' : 'V1';
    const countries = [...new Set(getOtpHistory()
        .filter(item => String(item.server || 'V1').toUpperCase() === normalizedServer)
        .map(item => String(item.country || 'UNKNOWN').toUpperCase()))]
        .map(code => ({ code, name: getCountryName(code), flag: getCountryFlag(code) }))
        .sort((a, b) => a.name.localeCompare(b.name));

    if (countries.length === 0) return sendBQ(chatId, `📂 Tidak ada data OTP ${normalizedServer}.`);

    const keyboard = [];
    for (let i = 0; i < countries.length; i += 2) {
        const row = [{ text: `${countries[i].flag} ${countries[i].name}`, callback_data: `otp_country:${normalizedServer.toLowerCase()}:${countries[i].code}` }];
        if (countries[i + 1]) row.push({ text: `${countries[i + 1].flag} ${countries[i + 1].name}`, callback_data: `otp_country:${normalizedServer.toLowerCase()}:${countries[i + 1].code}` });
        keyboard.push(row);
    }
    keyboard.push([{ text: '⬅️ PILIH SERVER', callback_data: 'admin_list_otp' }]);
    return bot.sendMessage(chatId, `📋 <b>PILIH NEGARA — LIST OTP ${normalizedServer}</b>`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    });
}

async function handleListOtp(chatId, countryCode, server = 'v1') {
    const normalizedServer = String(server).toUpperCase() === 'V2' ? 'V2' : 'V1';
    const history = getOtpHistory().filter(item =>
        String(item.country || 'UNKNOWN').toUpperCase() === countryCode.toUpperCase() &&
        String(item.server || 'V1').toUpperCase() === normalizedServer
    );
    if (history.length === 0) return sendBQ(chatId, `📋 Tidak ada OTP ${normalizedServer} untuk negara ${countryCode}`);

    const flag = getCountryFlag(countryCode);
    const name = getCountryName(countryCode);
    const filePath = path.join(__dirname, `otp_${normalizedServer}_${countryCode}_${Date.now()}.txt`);
    const content = history.map(item => {
        const num = String(item.number).replace(/[^0-9]/g, '');
        return num ? `+${num}` : '';
    }).filter(Boolean).join('\n') + '\n';

    fs.writeFileSync(filePath, content, 'utf8');
    const caption = `📄 LIST OTP ${normalizedServer} — ${flag} ${name}\n📦 Total: ${history.length}`;
    await bot.sendDocument(chatId, filePath, { caption }).catch(() => {});
    try { fs.unlinkSync(filePath); } catch (e) {}
}

// ============================================================
// OTP REPORT KE CHANNEL
// ============================================================
async function sendOtpReportToChannel() {
    const history = getOtpHistory();
    if (history.length === 0) return;

    const grouped = {};
    history.forEach(item => {
        const country = item.country || 'UNKNOWN';
        if (!grouped[country]) grouped[country] = [];
        grouped[country].push(item);
    });

    for (const [country, data] of Object.entries(grouped)) {
        const flag = getCountryFlag(country);
        const name = getCountryName(country);
        const filePath = path.join(__dirname, `otp_report_${country}_${Date.now()}.txt`);

        let content = `📋 OTP REPORT - ${flag} ${name} (${data.length} total)\n`;
        content += `━━━━━━━━━━━━━━━━━━━━━\n`;
        content += `Tanggal: ${new Date().toLocaleDateString('id-ID')}\n`;
        content += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

        data.forEach((item, index) => {
            const date = new Date(item.timestamp).toLocaleString('id-ID');
            content += `${index + 1}. ${item.app} | ${item.otp} | +${item.number} | ${date}\n`;
        });

        fs.writeFileSync(filePath, content, 'utf8');
        const caption = `📤 OTP Daily Report - ${flag} ${name}\n📦 Total: ${data.length} OTP`;
        await bot.sendDocument(settings.NOTIF_CHANNEL, filePath, { caption }).catch(() => {});
        try { fs.unlinkSync(filePath); } catch (e) {}
    }
}

// ============================================================
// AUTO DELETE OLD FILES
// ============================================================
async function autoDeleteOldFiles() {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
    const deleted = [], kept = [];
    const hours = settings.AUTO_DELETE_HOURS || 24;

    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        const age = getFileAge(filePath);
        const country = file.replace('.txt', '').toUpperCase();
        const content = fs.readFileSync(filePath, 'utf8');
        const count = (content.match(/\d{9,15}/g) || []).length;

        if (age > hours) {
            fs.unlinkSync(filePath);
            deleted.push({ flag: getCountryFlag(country), name: getCountryName(country), age, count });
        } else {
            kept.push({ flag: getCountryFlag(country), name: getCountryName(country), age, count });
        }
    }

    // Laporan AUTO DELETE dinonaktifkan; proses penghapusan file tetap berjalan.
}

// ============================================================
// FILTER BIO (WA BIASA / BISNIS)
// ============================================================
async function handleFilterBio(q, filterType, country) {
    const userId = q.from.id;
    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;

    if (!isPremium(userId) && !getSenderGlobal()) {
        return bot.answerCallbackQuery(q.id, { text: '❌ Fitur ini butuh Premium / Sender Global.', show_alert: true });
    }

    await bot.answerCallbackQuery(q.id, { text: `🔍 Filter: WA ${filterType === 'business' ? 'BISNIS' : 'BIASA'}` });

    const code = getCountryCodeFromName(country);
    const dir = DATA_DIR;
    const matchedFile = fs.readdirSync(dir).find(f => f.toLowerCase() === `${code.toLowerCase()}.txt`);
    if (!matchedFile) return bot.editMessageText('❌ File stok tidak ditemukan.', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });

    const file = path.join(dir, matchedFile);
    let nums = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!nums.length) return bot.editMessageText('❌ Stok habis.', { chat_id: chatId, message_id: messageId });

    const selected = [];
    for (let i = 0; i < Math.min(GET_NUMBER_BATCH_SIZE, nums.length); i++) {
        const idx = Math.floor(Math.random() * nums.length);
        selected.push(nums[idx].replace(/\D/g, ''));
        nums.splice(idx, 1);
    }
    fs.writeFileSync(file, nums.join('\n'));

    const flag = getCountryFlag(code);
    const countryName = getCountryName(code);

    const results = (await checkMultipleNumbers(userId, selected, true, null, 'Nomor')).map(r => ({
        ...r,
        match: r.registered && ((filterType === 'business' && r.accountType === 'business') || (filterType === 'personal' && r.accountType === 'personal'))
    }));
    cekBioStopState.delete(String(userId));

    let text = `🔍 <b>HASIL FILTER: WA ${filterType === 'business' ? 'BISNIS' : 'BIASA'}</b>\n📱 ${countryName} ${flag}\n\n`;
    const kb = [];
    kb.push([{ text: '📋 SALIN SEMUA', copy_text: { text: selected.map(n => '+' + n).join('\n') } }]);
    results.forEach(r => {
        const icon = r.match ? '✅' : '❌';
        const name = r.registered && r.name ? ` | ${r.name}` : '';
        text += `${icon} +${r.number}${name}\n`;
        kb.push([{ text: `${icon} +${r.number}`, copy_text: { text: '+' + r.number }, style: r.match ? 'success' : 'danger' }]);
    });
    kb.push([
        { text: "🔄 GANTI NOMOR", callback_data: `sel_country:${code.toLowerCase()}` },
        { text: "🌍 GANTI NEGARA", callback_data: "change_range" }
    ]);
    kb.push([{ text: '⬅️ KEMBALI', callback_data: 'back_to_menu' }]);

    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
}

// ============================================================
// SHOW MAIN MENU
// ============================================================
async function showMainMenu(chatId, firstName, userId) {
    const isNewUser = addUser(userId);
    const username = firstName || 'User';

    if (isNewUser && !isPremium(userId)) {
        addPremiumUser(userId, 1, 'GRATIS');
    }

    const totalUsers = getTotalUsers();
    const totalGroups = getGroups().length;
    const status = getSenderStatus(userId);
    const statusIcon = status === 'connected' ? '🟢' : '🔴';
    const statusText = status === 'connected' ? 'Terhubung' : 'Belum';

    if (isNewUser) {
        sendNewUserNotif(userId, username);
    }

    const checkStats = getCheckStats();

    let topWhatsAppCountries = [];
    try {
        const history = getOtpHistory();
        const waTraffic = {};
        history.forEach(item => {
            const app = String(item.app || '').toLowerCase();
            const code = String(item.country || '').toUpperCase();
            if (!code || code === 'UNKNOWN') return;
            if (!app.includes('whatsapp')) return;
            waTraffic[code] = (waTraffic[code] || 0) + 1;
        });
        topWhatsAppCountries = Object.entries(waTraffic).sort((a, b) => b[1] - a[1]).slice(0, 5);
    } catch (e) {}

    let highCountryText = 'Tidak ada data';
    if (topWhatsAppCountries.length) {
        highCountryText = topWhatsAppCountries
            .map(([code, count], index) => `${index + 1}. ${getCountryFlag(code)} ${getCountryName(code)} — ${count} OTP`)
            .join('\n');
    }

    const menuText = `<blockquote>👑 <b>Hallo @${username}</b>
Selamat datang di bot!

━━━━━━━━━━━━━━━━━━
📊 <b>INFORMASI BOT</b>
👤 Total User : ${totalUsers}
👥 Total Group : ${totalGroups}
⚡ Version : 10 Unlimited
💻 Type Code : Javascript

📈 <b>HASIL CEK</b>
📱 Nomor dicek : ${checkStats.checked}
✅ Nomor terdaftar : ${checkStats.registered}
💼 WA bisnis : ${checkStats.business}
👤 WA biasa : ${checkStats.personal}
🔑 Total OTP diterima : ${getOtpHistory().length}

🔥 <b>NEGARA HIGH WA</b>
${highCountryText}
━━━━━━━━━━━━━━━━━━

📱 WhatsApp : ${statusIcon} <b>${statusText}</b>

Silakan pilih menu di bawah 👇</blockquote>`;

    const keyboard = {
        keyboard: [
            ['☎️ GET NUMBER', '📂 GET FILE'],
            ['🔍 CEK OTP', '📊 TRAFFIC'],
            ['🛠️ LIST FITUR', '➕ ADD WA'],
            ['🗑️ HAPUS WA']
        ],
        resize_keyboard: true
    };

    try {
        await bot.sendAudio(chatId, 'https://files.catbox.moe/nmdo4w.mp3', {
            caption: menuText,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (e) {
        bot.sendMessage(chatId, menuText, { parse_mode: 'HTML', reply_markup: keyboard });
    }
}

// ============================================================
// SHOW LIST FITUR (ADMIN PANEL)
// ============================================================
function showListFitur(chatId, userId) {
    const isOwner = isOwnerId(userId);
    if (!isOwner) return sendBQ(chatId, "❌ Menu ini hanya dapat digunakan Owner.");

    const menuText = `╭━━━〔 🛠️ ADMIN PANEL 〕━━━╮\n│\n├ 🗑️ DEL FILE\n├ 🔵 ADD STOK V2\n├ 🔵 STOK V2\n├ 🗑️ DEL ALL STOK\n├ 📋 LIST GRUP\n├ ➕ ADD GRUP\n├ 🗑️ DEL GRUP\n├ 📊 LIHAT STOK ALL\n├ 📋 LIST OTP\n├ ⛔ STOP OTP\n├ 📢 BROADCAST\n├ 💎 MANAGE PREMIUM\n├ 📱 LIST SENDER GLOBAL\n├ 🏆 TOP USER\n│\n╰━━━〔 ⬅️ KEMBALI 〕━━━╯`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "🗑️ DEL FILE", callback_data: "admin_del_file" }],
            [{ text: "➕ ADD STOK V2", callback_data: "admin_add_stok_v2" }],
            [{ text: "📊 STOK V2", callback_data: "admin_view_stok_v2" }],
            [{ text: "🗑️ DEL ALL STOK", callback_data: "admin_del_all_stok" }],
            [{ text: "📋 LIST GRUP", callback_data: "admin_list_grup" }],
            [{ text: "➕ ADD GRUP", callback_data: "admin_add_grup" }],
            [{ text: "🗑️ DEL GRUP", callback_data: "admin_del_grup" }],
            [{ text: "📊 LIHAT STOK ALL", callback_data: "admin_view_all_stok" }],
            [{ text: "📋 LIST OTP", callback_data: "admin_list_otp" }],
            [{ text: "⛔ STOP OTP", callback_data: "admin_stop_otp" }],
            [{ text: "📢 BROADCAST", callback_data: "admin_broadcast" }],
            [{ text: "💎 MANAGE PREMIUM", callback_data: "admin_manage_premium" }],
            [{ text: "📱 LIST SENDER GLOBAL", callback_data: "admin_list_sender" }],
            [{ text: "🏆 TOP USER", callback_data: "admin_top_user" }],
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]
        ]
    };

    bot.sendMessage(chatId, menuText, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ============================================================
// PREMIUM MENU (user biasa)
// ============================================================
async function handlePremiumMenu(chatId, userId) {
    const isPremiumUser = isPremium(userId);
    const expired = getPremiumExpired(userId);
    const quota = getUserQuota(userId);
    const totalQuota = getTotalQuota();

    let text = `╭━━━〔 💎 BOT PREMIUM 〕━━━╮\n│\n`;

    if (isPremiumUser) {
        text += `├ 👑 <b>Status: PREMIUM</b>\n`;
        text += `├ 📅 Masa Aktif: ${new Date(expired).toLocaleDateString('id-ID')}\n`;
    } else {
        text += `├ 👤 <b>Status: FREE</b>\n`;
        text += `├ 🎁 Quota Sender Global: ${totalQuota}x/hari\n`;
        text += `├ 💡 <i>Upgrade ke premium untuk akses unlimited</i>\n`;
    }

    text += `│\n`;
    text += `├ 🗓️ 2 Hari  — 1K\n`;
    text += `├ 🗓️ 4 Hari  — 2K\n`;
    text += `├ 🗓️ 6 Hari  — 3K\n`;
    text += `├ 🗓️ 8 Hari  — 4K\n`;
    text += `├ 🗓️ 10 Hari — 5K\n`;
    text += `├ 🗓️ 12 Hari — 6K\n`;
    text += `├ 🗓️ 14 Hari — 7K\n`;
    text += `├ 🗓️ 16 Hari — 8K\n`;
    text += `├ 🗓️ 18 Hari — 9K\n`;
    text += `├ 🗓️ 20 Hari — 10K\n`;
    text += `├ 🗓️ 22 Hari — 11K\n`;
    text += `├ 🗓️ 24 Hari — 12K\n`;
    text += `├ 🗓️ 26 Hari — 13K\n`;
    text += `├ 🗓️ 28 Hari — 14K\n`;
    text += `├ 🗓️ 30 Hari — 15K\n`;
    text += `│\n`;
    text += `├ ⭐ 2 Bulan — 30K\n`;
    text += `├ 👑 3 Bulan — 45K\n`;
    text += `│\n`;
    text += `╰━━━━━━━━━━━━━━━━━━╯\n\n`;
    text += `📩 MINAT? CHAT ADMIN: @Orvinz`;

    const kb = [];
    if (isPremiumUser) {
        kb.push([{ text: "📅 CEK MASA AKTIF", callback_data: "premium_check" }]);
    }
    kb.push([{ text: "⬅️ KEMBALI", callback_data: "back_to_menu" }]);

    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
}

// ============================================================
// TOP USER
// ============================================================
async function handleTopUser(chatId, isAdmin = false) {
    const topUsers = getTopUsers(10);
    if (topUsers.length === 0) {
        const text = `🏆 <b>TOP USER</b>\n━━━━━━━━━━━━━━━━━━━━━\n\n❌ Belum ada user yang aktif.\n\n💡 User akan muncul di sini setelah melakukan aktivitas.`;
        const keyboard = { inline_keyboard: [
            [{ text: "🔄 REFRESH", callback_data: "top_user" }],
            [{ text: "⬅️ KEMBALI", callback_data: "back_to_menu" }]
        ] };
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }

    let text = `🏆 <b>TOP USER</b>\n━━━━━━━━━━━━━━━━━━━━━\n📊 Berdasarkan total aktivitas\n\n`;
    const medals = ['👑', '🥈', '🥉'];

    for (let index = 0; index < topUsers.length; index++) {
        const [userId, stats] = topUsers[index];
        const medal = index < 3 ? medals[index] : `${index + 1}.`;
        let username = 'Unknown';
        try {
            const user = await bot.getChat(parseInt(userId));
            username = user.username || user.first_name || userId;
        } catch (e) {
            username = userId;
        }
        text += `${medal} <b>@${username}</b>\n`;
        text += `   📦 Ambil Nomor: ${stats.get_number}x\n`;
        text += `   🔍 Cek Bio: ${stats.cek_bio}x\n`;
        text += `   📊 Total: ${stats.total}x\n`;
        text += `   🕐 Terakhir: ${new Date(stats.last_active).toLocaleString('id-ID')}\n\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━━━━\n📦 Total User Aktif: ${topUsers.length}`;
    const kb = [
        [{ text: "🔄 REFRESH", callback_data: "top_user" }],
        [{ text: "⬅️ KEMBALI", callback_data: "back_to_menu" }]
    ];
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
}

// ============================================================
// MANAGE PREMIUM (Admin)
// ============================================================
async function handleManagePremium(chatId) {
    const text = `╭━━━〔 💎 MANAGE PREMIUM 〕━━━╮\n│\n├ 👤 LIST PREMIUM USER\n├ ➕ ADD PREMIUM\n├ 🗑️ REMOVE PREMIUM\n├ 📅 CEK EXPIRED\n│\n╰━━━〔 ⬅️ KEMBALI 〕━━━╯`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "👤 LIST PREMIUM USER", callback_data: "premium_list" }],
            [{ text: "➕ ADD PREMIUM", callback_data: "premium_add" }],
            [{ text: "🗑️ REMOVE PREMIUM", callback_data: "premium_remove" }],
            [{ text: "📅 CEK EXPIRED", callback_data: "premium_check_expired" }],
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]
        ]
    };
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handlePremiumList(chatId) {
    const premium = getPremiumUsers();
    const keys = Object.keys(premium);
    if (keys.length === 0) return sendBQ(chatId, "❌ Belum ada user premium.");

    let text = "👤 <b>LIST PREMIUM USER</b>\n━━━━━━━━━━━━━━━━━━━━━\n";
    let index = 1;
    for (const [userId, data] of Object.entries(premium)) {
        const expired = new Date(data.expired).toLocaleDateString('id-ID');
        const isExpired = new Date(data.expired) < new Date();
        const status = isExpired ? '❌ EXPIRED' : '✅ AKTIF';
        try {
            const user = await bot.getChat(userId);
            const username = user.username || user.first_name || userId;
            text += `${index}. @${username} (${userId})\n   📦 ${data.package} | ${data.price}\n   📅 ${expired} | ${status}\n\n`;
        } catch (e) {
            text += `${index}. User ID: ${userId}\n   📦 ${data.package} | ${data.price}\n   📅 ${expired} | ${status}\n\n`;
        }
        index++;
    }
    text += `━━━━━━━━━━━━━━━━━━━━━\n📦 Total: ${keys.length} user premium`;

    const keyboard = { inline_keyboard: [[{ text: "⬅️ KEMBALI", callback_data: "admin_manage_premium" }]] };
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handlePremiumAdd(chatId) {
    sendBQ(chatId, "📝 Masukkan ID User yang ingin dijadikan premium.\n\nContoh: <code>123456789</code>");
    userSession.set(chatId, { step: 'waiting_premium_user' });
}

async function handlePremiumRemove(chatId) {
    sendBQ(chatId, "📝 Masukkan ID User yang ingin dihapus dari premium.");
    userSession.set(chatId, { step: 'waiting_premium_remove' });
}

const PREMIUM_PACKAGE_DAYS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 60, 90];

function premiumPackageKeyboard(targetUserId) {
    const rows = [];
    for (let i = 0; i < PREMIUM_PACKAGE_DAYS.length; i += 3) {
        rows.push(PREMIUM_PACKAGE_DAYS.slice(i, i + 3).map(days => ({
            text: `${days === 60 ? '2 Bulan' : days === 90 ? '3 Bulan' : days + ' Hari'} — ${getPrice(days)}`,
            callback_data: `premium_select_days:${targetUserId}:${days}`
        })));
    }
    rows.push([{ text: "❌ BATAL", callback_data: "premium_cancel" }]);
    return { inline_keyboard: rows };
}

async function handlePremiumCheckExpired(chatId) {
    const premium = getPremiumUsers();
    const keys = Object.keys(premium);
    if (keys.length === 0) return sendBQ(chatId, "❌ Belum ada user premium.");

    let text = "📅 <b>CEK EXPIRED PREMIUM</b>\n━━━━━━━━━━━━━━━━━━━━━\n";
    let expiredCount = 0;
    for (const [userId, data] of Object.entries(premium)) {
        const expired = new Date(data.expired);
        const isExpired = expired < new Date();
        if (isExpired) {
            expiredCount++;
            try {
                const user = await bot.getChat(userId);
                const username = user.username || user.first_name || userId;
                text += `❌ @${username} (${userId}) - ${expired.toLocaleDateString('id-ID')}\n`;
            } catch (e) {
                text += `❌ User ID: ${userId} - ${expired.toLocaleDateString('id-ID')}\n`;
            }
        }
    }
    if (expiredCount === 0) text += "✅ Semua user premium masih aktif!";
    text += `\n━━━━━━━━━━━━━━━━━━━━━\n📦 Total expired: ${expiredCount}`;

    const keyboard = { inline_keyboard: [[{ text: "⬅️ KEMBALI", callback_data: "admin_manage_premium" }]] };
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ============================================================
// LIST SENDER GLOBAL
// ============================================================
async function handleListSenderGlobal(chatId) {
    const active = getActiveSenders();
    const keys = Object.keys(active);

    if (keys.length === 0) {
        const text = `📱 <b>LIST SENDER GLOBAL</b>\n━━━━━━━━━━━━━━━━━━━━━\n\n❌ Belum ada sender aktif.\n\n💡 Sender akan muncul di sini setelah user ADD WA.`;
        const keyboard = { inline_keyboard: [
            [{ text: "🔄 REFRESH", callback_data: "admin_list_sender" }],
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]
        ] };
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }

    let text = `📱 <b>LIST SENDER GLOBAL (AKTIF)</b>\n━━━━━━━━━━━━━━━━━━━━━\n\n🟢 <b>AKTIF:</b>\n\n`;
    let index = 1;
    let allNumbers = [];

    for (const [userId, data] of Object.entries(active)) {
        const username = data.username || 'Unknown';
        const connectedAt = new Date(data.connected_at).toLocaleString('id-ID');
        text += `┌─────────────────────────────────────────┐\n`;
        text += `│ ${index}. @${username}\n`;
        text += `│    📱 +${data.phone}\n`;
        text += `│    🆔 ${userId}\n`;
        text += `│    🕐 ${connectedAt}\n`;
        text += `│    💻 ${data.platform || 'WhatsApp Web'}\n`;
        text += `└─────────────────────────────────────────┘\n\n`;
        allNumbers.push(`+${data.phone}`);
        index++;
    }

    text += `━━━━━━━━━━━━━━━━━━━━━\n📦 Total Sender Aktif: ${keys.length}`;

    const allNumbersText = allNumbers.join('\n');
    const keyboard = {
        inline_keyboard: [
            [{ text: "📋 COPY ALL NOMOR", copy_text: { text: allNumbersText } }],
            [{ text: "🔄 REFRESH", callback_data: "admin_list_sender" }],
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]
        ]
    };

    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ============================================================
// GRUP MANAGEMENT
// ============================================================
async function showListGrup(chatId) {
    const groups = getGroups();
    if (groups.length === 0) return sendBQ(chatId, "📋 Daftar grup kosong.");

    let text = "📋 <b>Daftar Grup OTP</b>\n\n";
    let index = 1;
    for (const gid of groups) {
        let name = gid;
        try { const chat = await bot.getChat(gid); name = chat.title || chat.username || gid; } catch (e) { name = gid; }
        text += `${index}. ${name}\n`;
        index++;
    }
    text += `\nTotal: <b>${groups.length}</b> Grup`;

    const keyboard = { inline_keyboard: [[{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]] };
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function showDeleteGrupMenu(chatId) {
    const groups = getGroups();
    if (groups.length === 0) return sendBQ(chatId, "📋 Daftar grup kosong.");

    const keyboard = [];
    for (const gid of groups) {
        let name = gid;
        try { const chat = await bot.getChat(gid); name = chat.title || chat.username || gid; } catch (e) { name = gid; }
        keyboard.push([{ text: `📢 ${name}`, callback_data: `del_grup:${gid}` }]);
    }
    keyboard.push([{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]);

    bot.sendMessage(chatId, "🗑️ <b>Pilih grup yang ingin dihapus:</b>", { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

// ============================================================
// ESCAPE HTML (dipakai V1 & V2)
// ============================================================
function escapeHtmlV1(text) {
    return String(text ?? "-")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ============================================================
// SEND TO GROUPS V1
// ============================================================
function sendToGroupsV1(rawNum, otp, appName, rawMessage, iso) {
    const groups = getGroups();
    if (groups.length === 0) { console.log("⚠️ Tidak ada grup V1"); return; }

    const cleanNum = String(rawNum).replace(/[^0-9]/g, "");
    const flag = getCountryFlag(iso);
    const countryName = getCountryName(iso);
    const maskedNumber = maskPhoneNumber(cleanNum);

    const cleanMessage = String(rawMessage ?? "-")
        .replace(/\\n/gi, "\n")
        .replace(/\\r/gi, "")
        .replace(/\\/g, "")
        .replace(/\r/g, "");

    const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    const text = [
        "<blockquote>",
        "📩 <b>SMS BARU TERDETEKSI</b>",
        "",
        `${flag} <b>#${escapeHtmlV1(iso)}</b> 💌 <code>${escapeHtmlV1(maskedNumber)}</code>`,
        "",
        `🌍 Negara : <b>${escapeHtmlV1(countryName)}</b>`,
        `🔧 Layanan : ${escapeHtmlV1(appName)}`,
        `🕐 Waktu : ${escapeHtmlV1(timeStr)}`,
        "",
        `🔐 Kode : <code>${escapeHtmlV1(otp)}</code>`,
        "",
        "📝 Pesan:",
        `<code>${escapeHtmlV1(cleanMessage)}</code>`,
        "</blockquote>"
    ].join("\n");

    const options = {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 COPY OTP", copy_text: { text: String(otp) }, style: "success" }],
                [
                    { text: "PANEL", url: "https://t.me/metodeneww", style: "primary" },
                    { text: "CEK BIO", url: "https://t.me/CEKBOIWHATSAPP_bot", style: "primary" }
                ],
                [
                    { text: "FIX MERAH", url: "https://t.me/MLOFixMerah_Bot?start=REF1971362361", style: "danger" },
                    { text: "JUAL NOKOS", url: "https://t.me/Ws_Sell_World_bot?start=ref_8448338520", style: "danger" }
                ],
                [{ text: "🔑 LIST SCAM", url: "https://t.me/listorangscam", style: "danger" }]
            ]
        }
    };

    groups.forEach(gid => {
        bot.sendMessage(gid, text, options)
            .then(msg => {
                console.log(`✅ OTP terkirim ke grup: ${gid}`);
                setTimeout(async () => {
                    try { await bot.deleteMessage(gid, msg.message_id); } catch (e) {}
                }, 300000);
            })
            .catch((err) => {
                console.error(`❌ Gagal kirim ke grup ${gid}:`, err.message);
            });
    });
}

// ============================================================
// SEND TO GROUPS V2 (format sama seperti V1) ✨ BARU
// ============================================================
function sendToGroupsV2(rawNum, otp, appName, rawMessage, iso) {
    const groups = getGroups();
    if (groups.length === 0) { console.log("⚠️ Tidak ada grup V2"); return; }

    const cleanNum = String(rawNum).replace(/[^0-9]/g, "");
    const maskedNumber = maskPhoneNumber(cleanNum);

    const cleanMessage = String(rawMessage ?? "-")
        .replace(/\\n/gi, "\n")
        .replace(/\\r/gi, "")
        .replace(/\\/g, "")
        .replace(/\r/g, "");

    const text = [
        "📩 <b>New SMS</b>",
        `From: ${escapeHtmlV1(appName || "WhatsApp")}`,
        `Nomor: <code>${escapeHtmlV1(maskedNumber)}</code>`,
        `OTP: <code>${escapeHtmlV1(otp)}</code>`,
        "",
        escapeHtmlV1(cleanMessage)
    ].join("\n");

    const options = {
        parse_mode: "HTML",
        disable_web_page_preview: true
    };

    groups.forEach(gid => {
        bot.sendMessage(gid, text, options)
            .then(msg => {
                console.log(`✅ SMS V2 terkirim ke grup: ${gid}`);
            })
            .catch((err) => {
                console.error(`❌ Gagal kirim V2 ke grup ${gid}:`, err.message);
            });
    });
}

// ============================================================
// CHECK API V1 (dengan Gacha V1)
// ============================================================
async function checkApi() {
    if (!getOtpControl().v1) return;
    try {
        const { data } = await axios.get(settings.API_URL, { timeout: 8000 });
        const dataList = Array.isArray(data) ? data : (data.data || []);

        for (const item of dataList.reverse()) {
            if (!item || !Array.isArray(item)) continue;

            const rawNum = (item[1] || "").toString().replace(/[^0-9]/g, '');
            const rawMessage = (item[2] || "").toString();
            const appName = (item[0] || "UNKNOWN").toString();

            const otp = extractOtpSmart(rawMessage);

            const uid = `${rawNum}_${otp}`.slice(0, 50);
            if (seen_otps.has(uid) || rawNum === "" || !otp || otp === "-") continue;
            seen_otps.add(uid);

            const country = detectCountryFromNumber(rawNum);
            const iso = country !== 'UNKNOWN' ? country : 'ID';

            if (country !== 'UNKNOWN') {
                try {
                    const trafficData = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'));
                    trafficData.daily[country] = (trafficData.daily[country] || 0) + 1;
                    fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(trafficData, null, 2));
                } catch (e) {}
            }

            saveOtpHistory({
                number: rawNum,
                otp: otp,
                app: appName,
                country: country || 'UNKNOWN',
                message: rawMessage,
                server: 'V1'
            });

            // === GACHA V1: kirim OTP ke user yang ambil nomor itu ===
            for (let [num, chatId] of takenNumbers) {
                if (rawNum.endsWith(num) || num.endsWith(rawNum)) {
                    const gachaText = `🎰 <b>GACHA OTP BERHASIL!</b>\n\n📱 <b>App:</b> ${appName}\n🔢 <b>No:</b> +${rawNum}\n🔑 <b>OTP:</b> <code>${otp}</code>`;
                    bot.sendMessage(chatId, gachaText, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: "📋 COPY OTP", copy_text: { text: String(otp) }, style: "success" }]] }
                    }).catch(() => {});
                    takenNumbers.delete(num);
                    console.log(`🎰 Gacha V1 terkirim ke user ${chatId} untuk +${num}`);
                }
            }

            // Kirim ke grup V1
            sendToGroupsV1(rawNum, otp, appName, rawMessage, iso);
        }
    } catch (e) {
        console.error("API Monitoring Error:", e.message);
    }
}

// ============================================================
// CRON JOBS
// ============================================================
cron.schedule('0 0 * * *', async () => {
    console.log('🗑️ Auto Delete berjalan...');
    await autoDeleteOldFiles();
    console.log('🔄 Reset traffic dan quota...');
    const trafficData = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'));
    trafficData.daily = {};
    trafficData.lastReset = Date.now();
    fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(trafficData, null, 2));
    resetQuotaDaily();
    console.log('✅ Selesai!');
});

setInterval(checkApi, 2000);
setInterval(checkBashaOtpV2, Number(settings.BASHA_POLL_INTERVAL || 2000));

// ============================================================
// ADMIN — STOK V2
// ============================================================
function showStokV2(chatId) {
    const countries = getAllCountriesFromDir(DATA_V2_DIR);
    if (!countries.length) return sendBQ(chatId, '🔵 Stok V2 masih kosong.');
    let text = '🔵 <b>STOK V2</b>\n━━━━━━━━━━━━━━━━━━━━\n';
    let total = 0;
    countries.forEach(c => { text += `${c.flag} ${c.name}: ${c.stock} nomor\n`; total += c.stock; });
    text += `━━━━━━━━━━━━━━━━━━━━\n📦 <b>Total: ${total} nomor</b>`;
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_back_menu' }]] } });
}





// ============================================================
// DELETE STOCK — PILIH SERVER
// ============================================================
function showDeleteServerMenu(chatId, action) {
    const title = action === 'all' ? '🗑️ <b>PILIH SERVER DEL ALL STOK</b>' : '🗑️ <b>PILIH SERVER DEL FILE</b>';
    const keyboard = {
        inline_keyboard: [
            [{ text: '🟢 V1 — SERVER 1', callback_data: `del_select_server:${action}:v1` }],
            [{ text: '🔵 V2 — SERVER 2 / BASHA', callback_data: `del_select_server:${action}:v2` }],
            [{ text: '⬅️ KEMBALI', callback_data: 'admin_back_menu' }]
        ]
    };
    return bot.sendMessage(chatId, title, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ============================================================
// OTP CONTROL (OWNER)
// ============================================================
function showOtpControlMenu(chatId) {
    const state = getOtpControl();
    const v1 = state.v1 ? '🟢 AKTIF' : '🔴 STOP';
    const v2 = state.v2 ? '🟢 AKTIF' : '🔴 STOP';
    const text = `⛔ <b>STOP OTP</b>\n\n🟢 V1 : <b>${v1}</b>\n🔵 V2 : <b>${v2}</b>\n\nPilih server yang ingin diatur:`;
    const keyboard = { inline_keyboard: [
        [{ text: `🟢 STOP/START V1 — ${state.v1 ? 'AKTIF' : 'STOP'}`, callback_data: 'otp_toggle:v1' }],
        [{ text: `🔵 STOP/START V2 — ${state.v2 ? 'AKTIF' : 'STOP'}`, callback_data: 'otp_toggle:v2' }],
        [{ text: '⬅️ KEMBALI', callback_data: 'admin_back_menu' }]
    ]};
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ============================================================
// CALLBACK QUERY HANDLER
// ============================================================
bot.on('callback_query', async (q) => {
    if (!q.message) return;
    const { chat, message_id } = q.message;

    try {
        // === ADMIN: STOK V2 ===
        if (q.data === 'admin_add_stok_v2') {
            if (!isOwnerId(q.from.id)) return bot.answerCallbackQuery(q.id, { text: '❌ Owner only', show_alert: true });
            userSession.set(q.from.id, { step: 'waiting_add_stok_v2' });
            await bot.sendMessage(chat.id, '🔵 <b>ADD STOK V2</b>\n\nKirim file TXT berisi nomor yang memang dialokasikan untuk akun Basha.\nContoh nama file: <code>NL.txt</code>', { parse_mode: 'HTML' });
            return bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_view_stok_v2') {
            if (!isOwnerId(q.from.id)) return bot.answerCallbackQuery(q.id, { text: '❌ Owner only', show_alert: true });
            showStokV2(chat.id);
            return bot.answerCallbackQuery(q.id);
        } else if (q.data === 'select_upload_mode:v1' || q.data === 'select_upload_mode:v2') {
            if (!isOwnerId(q.from.id)) return bot.answerCallbackQuery(q.id, { text: '❌ Owner only', show_alert: true });

            const mode = q.data.endsWith(':v2') ? 'v2' : 'v1';
            const batch = server2PendingUploads.get(q.from.id);
            if (!batch || !Array.isArray(batch.files) || !batch.files.length) {
                return bot.answerCallbackQuery(q.id, { text: '❌ File sudah tidak tersedia.', show_alert: true });
            }

            if (batch.timer) clearTimeout(batch.timer);
            batch.mode = mode;
            batch.collecting = true;

            const keyboard = {
                inline_keyboard: [
                    [{ text: '✅ UPLOAD SEMUA KE STOK', callback_data: 'upload_stok' }],
                    [{ text: '❌ BATAL SEMUA', callback_data: 'cancel_upload' }]
                ]
            };

            let textConfirm = `<blockquote>📄 <b>KONFIRMASI UPLOAD</b>\n\n`;
            textConfirm += `📦 <b>${batch.files.length} file siap ditambahkan sekaligus</b>\n\n`;
            batch.files.forEach((file, index) => {
                textConfirm += `${index + 1}. 📂 <code>${escapeHtmlV1(file.fileName)}</code>\n`;
            });
            textConfirm += `\n🖥️ <b>Server tujuan:</b> ${mode === 'v2' ? '🔵 V2 / Basha' : '🟢 V1'}\n`;
            textConfirm += `\nSilakan pilih <b>UPLOAD SEMUA KE STOK</b> jika sudah benar.</blockquote>`;

            try {
                await bot.editMessageText(textConfirm, {
                    chat_id: chat.id,
                    message_id,
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            } catch (e) {
                await bot.sendMessage(chat.id, textConfirm, { parse_mode: 'HTML', reply_markup: keyboard });
            }
            batch.messageId = message_id;
            batch.collecting = false;
            return bot.answerCallbackQuery(q.id, { text: mode === 'v2' ? '🔵 Server V2 dipilih' : '🟢 Server V1 dipilih' });
        }

        // === UPLOAD FILE STOK (batch: 1 konfirmasi untuk banyak file) ===
        if (q.data === 'upload_stok') {
            const pendingState = server2PendingUploads.get(q.from.id);
            if (!pendingState) {
                await bot.answerCallbackQuery(q.id, { text: '❌ File sudah tidak tersedia.', show_alert: true });
                return;
            }

            if (pendingState.timer) clearTimeout(pendingState.timer);

            let pending = Array.isArray(pendingState.files)
                ? pendingState.files
                : (Array.isArray(pendingState) ? pendingState : [pendingState]);

            server2PendingUploads.delete(q.from.id);

            try {
                const uploadMode = pendingState.mode === 'v2' ? 'v2' : 'v1';
                const targetDir = uploadMode === 'v2' ? DATA_V2_DIR : DATA_DIR;
                const results = [];
                let totalNew = 0;

                for (const file of pending) {
                    let tmpPath = null;

                    try {
                        tmpPath = await bot.downloadFile(file.fileId, targetDir);
                        const content = fs.readFileSync(tmpPath, 'utf8');
                        const extractedNumbers = content.match(/\d{9,15}/g) || [];
                        // Hilangkan nomor duplikat di dalam file yang di-upload.
                        const newNumbers = [...new Set(extractedNumbers)];

                        if (!newNumbers.length) {
                            if (tmpPath && fs.existsSync(tmpPath)) {
                                try { fs.unlinkSync(tmpPath); } catch (e) {}
                            }
                            results.push({
                                ok: false,
                                fileName: file.fileName,
                                reason: 'tidak berisi nomor valid'
                            });
                            continue;
                        }

                        let countryName = file.fileName
                            .replace(/\.txt$/i, '')
                            .trim()
                            .split(/[-_\s]+/)[0]
                            .toLowerCase()
                            .replace(/[^a-z]/g, '');

                        if (!countryName || countryName.length < 2) {
                            if (tmpPath && fs.existsSync(tmpPath)) {
                                try { fs.unlinkSync(tmpPath); } catch (e) {}
                            }
                            results.push({
                                ok: false,
                                fileName: file.fileName,
                                reason: 'nama file tidak valid'
                            });
                            continue;
                        }

                        const targetFile = path.join(targetDir, `${countryName}.txt`);
                        let old = [];

                        if (fs.existsSync(targetFile)) {
                            old = fs.readFileSync(targetFile, 'utf8').match(/\d{9,15}/g) || [];
                        }

                        const oldUnique = [...new Set(old)];
                        const oldSet = new Set(oldUnique);
                        const actuallyAdded = newNumbers.filter(number => !oldSet.has(number));
                        const unique = [...new Set([...oldUnique, ...newNumbers])];
                        fs.writeFileSync(targetFile, unique.join('\n'), 'utf8');

                        if (
                            tmpPath &&
                            fs.existsSync(tmpPath) &&
                            path.resolve(tmpPath) !== path.resolve(targetFile)
                        ) {
                            try { fs.unlinkSync(tmpPath); } catch (e) {}
                        }

                        const code = resolveStockCountryCode(file.fileName);
                        const flag = getCountryFlag(code);
                        const displayName = getCountryName(code);

                        totalNew += actuallyAdded.length;
                        results.push({
                            ok: true,
                            fileName: file.fileName,
                            countryName,
                            flag,
                            displayName,
                            added: actuallyAdded.length,
                            duplicatesRemoved: extractedNumbers.length - newNumbers.length,
                            total: unique.length
                        });

                        if (uploadMode === 'v1') sendUploadNotif(countryName, unique.length);
                    } catch (fileError) {
                        if (tmpPath && fs.existsSync(tmpPath)) {
                            try { fs.unlinkSync(tmpPath); } catch (e) {}
                        }
                        results.push({
                            ok: false,
                            fileName: file.fileName,
                            reason: 'gagal diproses'
                        });
                        console.error(`Upload stock error (${file.fileName}):`, fileError);
                    }
                }

                const success = results.filter(r => r.ok);
                const failed = results.filter(r => !r.ok);

                if (!success.length) {
                    await bot.editMessageText(
                        `<blockquote>❌ <b>Upload gagal</b>\n\nTidak ada file yang berhasil ditambahkan.</blockquote>`,
                        { chat_id: chat.id, message_id, parse_mode: 'HTML' }
                    ).catch(() => {});

                    await bot.answerCallbackQuery(q.id, {
                        text: '❌ Semua file gagal diproses.',
                        show_alert: true
                    });
                    return;
                }

                let summary = `<blockquote>✅ <b>STOK BERHASIL DITAMBAHKAN</b>\n\n`;
                summary += `📂 <b>Total file:</b> ${pending.length}\n`;
                summary += `✅ <b>Berhasil:</b> ${success.length} file\n`;
                if (failed.length) summary += `❌ <b>Gagal:</b> ${failed.length} file\n`;
                summary += `📦 <b>Total nomor baru:</b> ${totalNew}\n`;
                summary += `🖥️ <b>Server:</b> ${uploadMode === 'v2' ? 'V2 / Basha' : 'V1'}\n\n`;

                for (const item of success) {
                    summary += `${item.flag} <b>${escapeHtmlV1(item.displayName)}</b>\n`;
                    summary += `📄 ${escapeHtmlV1(item.fileName)}\n`;
                    summary += `➕ ${item.added} nomor baru • 📊 ${item.total} total unik\n\n`;
                }

                if (failed.length) {
                    summary += `<b>File gagal:</b>\n`;
                    for (const item of failed) {
                        summary += `❌ ${escapeHtmlV1(item.fileName)} — ${escapeHtmlV1(item.reason)}\n`;
                    }
                    summary += `\n`;
                }

                summary += `<i>Semua stok yang berhasil diproses siap dipakai untuk GET NUMBER.</i></blockquote>`;

                await bot.editMessageText(summary, {
                    chat_id: chat.id,
                    message_id,
                    parse_mode: 'HTML'
                }).catch(() => {});

                await bot.answerCallbackQuery(q.id, {
                    text: `✅ ${success.length} file • ${totalNew} nomor baru ditambahkan`
                });
            } catch (e) {
                console.error('Batch upload stock error:', e);
                await bot.answerCallbackQuery(q.id, {
                    text: '❌ Gagal memproses batch file.',
                    show_alert: true
                }).catch(() => {});
            }
        } else if (q.data === 'cancel_upload') {
            const pendingCancel = server2PendingUploads.get(q.from.id);
            if (pendingCancel?.timer) clearTimeout(pendingCancel.timer);
            server2PendingUploads.delete(q.from.id);
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await bot.answerCallbackQuery(q.id, { text: 'Semua upload dibatalkan.' });

        // === FORCE JOIN ===
        } else if (q.data === 'check_join') {
            await bot.answerCallbackQuery(q.id, { text: "Memeriksa status..." });
            if (await isJoined(q.from.id)) {
                await bot.deleteMessage(chat.id, message_id).catch(() => {});
                showMainMenu(chat.id, q.from.first_name, q.from.id);
            } else {
                await bot.answerCallbackQuery(q.id, { text: "❌ Kamu belum bergabung di semua channel/grup wajib!", show_alert: true });
            }
        } else if (q.data === 'delete_message') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await bot.answerCallbackQuery(q.id);

        // === ADD WA / SENDER ===
        } else if (q.data === 'add_wa_menu') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            userSession.set(chat.id, { step: 'waiting_wa_pairing' });
            sendBQ(chat.id, "📱 Masukkan nomor WhatsApp Anda.\n\nContoh: 628123456789");
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'sender_global') {
            await handleSenderGlobal(q);
        } else if (q.data === 'sender_personal') {
            await handleSenderPersonal(q);
        } else if (q.data === 'confirm_delete_wa') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            const result = await deleteWASession(q.from.id);
            if (result.success) sendBQ(chat.id, "✅ WhatsApp berhasil dihapus dari bot.");
            else sendBQ(chat.id, "❌ Gagal menghapus WhatsApp.");
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'cancel_delete_wa') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await bot.answerCallbackQuery(q.id);

        // === MENU UTAMA ===
        } else if (q.data === 'back_to_menu') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            showMainMenu(chat.id, q.from.first_name, q.from.id);
            await bot.answerCallbackQuery(q.id);

        // === PREMIUM (user) ===
        } else if (q.data === 'premium_menu') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handlePremiumMenu(chat.id, q.from.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'premium_check') {
            const expired = getPremiumExpired(q.from.id);
            if (expired) {
                await bot.answerCallbackQuery(q.id, { text: `Masa aktif sampai: ${new Date(expired).toLocaleDateString('id-ID')}` });
            } else {
                await bot.answerCallbackQuery(q.id, { text: "❌ Anda bukan premium user!" });
            }

        // === TOP USER ===
        } else if (q.data === 'top_user') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleTopUser(chat.id);
            await bot.answerCallbackQuery(q.id);

        // === GET NUMBER / GET FILE ===
        } else if (q.data === 'get_number_menu') {
            showServerMenu(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'get_server:v1') {
            showCountryMenu(chat.id, message_id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'get_server:v2') {
            showCountryMenuV2(chat.id, message_id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('sel_country_v2:')) {
            const country = q.data.split(':')[1];
            userSession.set(chat.id, { selectedCountry: country, server: 'v2' });
            await showNumbersV2(q, country);
        } else if (q.data === 'change_range') {
            showCountryMenu(chat.id, message_id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('sel_country:')) {
            const country = q.data.split(':')[1];
            userSession.set(chat.id, { selectedCountry: country });
            await showNumbers(q, country);
        } else if (q.data === 'get_file_menu') {
            await handleGetFileMenu(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('get_file_server:')) {
            const server = q.data.split(':')[1] === 'v2' ? 'v2' : 'v1';
            await showGetFileList(chat.id, message_id, server);
            await bot.answerCallbackQuery(q.id, { text: `📂 GET FILE ${server.toUpperCase()}` });
        } else if (q.data.startsWith('dl_file:')) {
            const parts = q.data.split(':');
            const server = parts[1] === 'v2' ? 'v2' : 'v1';
            const countryCode = getCountryCodeFromName(parts[2] || '');
            const dir = server === 'v2' ? DATA_V2_DIR : DATA_DIR;
            const filePath = consolidateCountryFiles(dir, countryCode);

            if (filePath && fs.existsSync(filePath)) {
                await bot.sendDocument(chat.id, filePath, {
                    caption: `📂 GET FILE ${server.toUpperCase()} — ${getCountryFlag(countryCode)} ${getCountryName(countryCode)}`
                });
                await bot.answerCallbackQuery(q.id, { text: `📂 File ${server.toUpperCase()} dikirim.` });
            } else {
                await bot.answerCallbackQuery(q.id, { text: "❌ File tidak ditemukan!", show_alert: true });
            }

        // === FILTER BIO ===
        } else if (q.data.startsWith('filter_bio:')) {
            const parts = q.data.split(':');
            await handleFilterBio(q, parts[1], parts[2]);

        // === ADMIN: DEL FILE / DEL ALL ===
        } else if (q.data === 'admin_back_menu') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            showListFitur(chat.id, q.from.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_del_file') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showDeleteServerMenu(chat.id, 'file');
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_del_all_stok') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showDeleteServerMenu(chat.id, 'all');
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('del_select_server:')) {
            const parts = q.data.split(':');
            const action = parts[1];
            const server = parts[2] === 'v2' ? 'v2' : 'v1';
            if (action === 'file') {
                await bot.deleteMessage(chat.id, message_id).catch(() => {});
                await showDeleteFileMenu(chat.id, server);
            } else if (action === 'all') {
                await bot.deleteMessage(chat.id, message_id).catch(() => {});
                await handleDeleteAllStok(chat.id, server);
            }
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('confirm_del_all_stok:')) {
            const server = q.data.split(':')[1] === 'v2' ? 'v2' : 'v1';
            const dir = server === 'v2' ? DATA_V2_DIR : DATA_DIR;
            const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.txt')) : [];
            let deleted = 0;
            files.forEach(file => {
                try { fs.unlinkSync(path.join(dir, file)); deleted++; } catch (_) {}
            });
            const keyboard = { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_back_menu' }]] };
            await bot.editMessageText(`✅ <b>Berhasil menghapus ${deleted} file stok ${server.toUpperCase()}!</b>`, { chat_id: chat.id, message_id: message_id, parse_mode: 'HTML', reply_markup: keyboard });
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('del_file:')) {
            const parts = q.data.split(':');
            const server = parts[1] === 'v2' ? 'v2' : 'v1';
            const fileName = parts.slice(2).join(':');
            const dir = server === 'v2' ? DATA_V2_DIR : DATA_DIR;
            const filePath = path.join(dir, fileName);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                const country = fileName.replace('.txt', '').toUpperCase();
                const flag = getCountryFlag(country);
                const name = getCountryName(country);
                const keyboard = { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_back_menu' }]] };
                await bot.editMessageText(`✅ File ${flag} <b>${name}</b> dari ${server.toUpperCase()} berhasil dihapus.`, { chat_id: chat.id, message_id: message_id, parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                await bot.answerCallbackQuery(q.id, { text: '❌ File tidak ditemukan!', show_alert: true });
            }
            await bot.answerCallbackQuery(q.id);
        }

        // === ADMIN: GRUP ===
        else if (q.data === 'admin_list_grup') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showListGrup(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_add_grup') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            sendBQ(chat.id, "📝 Masukkan ID Grup.\n\n<i>Pastikan bot sudah menjadi admin dan memiliki izin Mengelola Pesan.</i>");
            userSession.set(chat.id, { step: 'waiting_add_grup' });
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_del_grup') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showDeleteGrupMenu(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('del_grup:')) {
            const grupId = q.data.split(':')[1];
            const keyboard = { inline_keyboard: [
                [{ text: "✅ Ya", callback_data: `confirm_del_grup_yes:${grupId}` }],
                [{ text: "❌ Tidak", callback_data: "confirm_del_grup_no" }]
            ] };
            await bot.editMessageText(`⚠️ Yakin ingin menghapus grup ini?\n\n<code>${grupId}</code>`, { chat_id: chat.id, message_id: message_id, parse_mode: 'HTML', reply_markup: keyboard });
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('confirm_del_grup_yes:')) {
            const grupId = q.data.split(':')[1];
            let groups = getGroups();
            if (groups.includes(grupId)) {
                groups = groups.filter(id => id !== grupId);
                fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
                const keyboard = { inline_keyboard: [[{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu" }]] };
                await bot.editMessageText(`✅ Grup <code>${grupId}</code> berhasil dihapus.`, { chat_id: chat.id, message_id: message_id, parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                await bot.editMessageText(`❌ Grup <code>${grupId}</code> tidak ditemukan.`, { chat_id: chat.id, message_id: message_id, parse_mode: 'HTML' });
            }
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'confirm_del_grup_no') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showDeleteGrupMenu(chat.id);
            await bot.answerCallbackQuery(q.id);

        // === ADMIN: STOK / OTP ===
        } else if (q.data === 'admin_view_all_stok') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleViewAllStok(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_list_otp') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleListOtpCountry(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_stop_otp') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            showOtpControlMenu(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('otp_toggle:')) {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Menu ini hanya untuk Owner.', show_alert: true });
                return;
            }
            const server = q.data.split(':')[1];
            const current = getOtpControl();
            const next = !current[server];
            setOtpControl(server, next);
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showOtpControlMenu(chat.id);
            await bot.answerCallbackQuery(q.id, { text: `${server.toUpperCase()} ${next ? 'diaktifkan' : 'dihentikan'}` });
        } else if (q.data.startsWith('otp_server:')) {
            const server = q.data.split(':')[1] === 'v2' ? 'v2' : 'v1';
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleListOtpCountry(chat.id, server);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('otp_country:')) {
            const parts = q.data.split(':');
            const server = parts[1] === 'v2' ? 'v2' : 'v1';
            const country = parts.slice(2).join(':');
            await handleListOtp(chat.id, country, server);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('stop_cekbio:')) {
            const stopUserId = q.data.split(':')[1];
            if (String(q.from.id) !== String(stopUserId)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Ini bukan proses kamu.', show_alert: true });
                return;
            }
            cekBioStopState.set(String(stopUserId), true);
            await bot.answerCallbackQuery(q.id, { text: '⛔ Proses dihentikan. Hasil yang sudah dicek akan dikirim.' });
            await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '⏹️ MENGHENTIKAN...', callback_data: 'stop_cekbio_done' }]] }, {
                chat_id: q.message.chat.id,
                message_id: q.message.message_id
            }).catch(() => {});
        } else if (q.data === 'stop_cekbio_done') {
            await bot.answerCallbackQuery(q.id, { text: '⏳ Sedang mengirim hasil...' });
        // === ADMIN: BROADCAST ===
        } else if (q.data === 'admin_broadcast') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            sendBQ(chat.id, "📢 Kirimkan pesan yang ingin di-broadcast ke semua user.\n\nKirim pesan teks, foto, video, atau dokumen.");
            userSession.set(chat.id, { step: 'waiting_broadcast' });
            await bot.answerCallbackQuery(q.id);

        // === ADMIN: MANAGE PREMIUM ===
        } else if (q.data === 'admin_manage_premium') {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleManagePremium(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'premium_list') {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handlePremiumList(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'premium_add') {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handlePremiumAdd(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'premium_remove') {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handlePremiumRemove(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'premium_check_expired') {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handlePremiumCheckExpired(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('premium_select_days:')) {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            const parts = q.data.split(':');
            const targetUserId = parts[1];
            const days = parseInt(parts[2], 10);
            if (!/^\d{5,20}$/.test(targetUserId) || !PREMIUM_PACKAGE_DAYS.includes(days)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Data paket tidak valid.' });
                return;
            }
            const price = getPrice(days);
            const packageName = days === 60 ? '2 Bulan' : days === 90 ? '3 Bulan' : `${days} Hari`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: `✅ KONFIRMASI ${packageName.toUpperCase()}`, callback_data: `premium_confirm:${targetUserId}:${days}` }],
                    [{ text: '⬅️ GANTI PAKET', callback_data: `premium_add` }],
                    [{ text: '❌ BATAL', callback_data: 'premium_cancel' }]
                ]
            };
            await bot.editMessageText(
                `❓ <b>Konfirmasi Premium</b>\n\n👤 User ID: <code>${targetUserId}</code>\n📦 Paket: <b>${packageName}</b>\n💰 Harga: <b>${price}</b>\n\nApakah data sudah benar?`,
                { chat_id: chat.id, message_id, parse_mode: 'HTML', reply_markup: keyboard }
            );
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('premium_confirm:')) {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            const parts = q.data.split(':');
            const targetUserId = parts[1];
            const days = parseInt(parts[2], 10);
            if (!/^\d{5,20}$/.test(targetUserId) || !PREMIUM_PACKAGE_DAYS.includes(days)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Data premium tidak valid.' });
                return;
            }
            const price = getPrice(days);
            const packageName = days === 60 ? '2 Bulan' : days === 90 ? '3 Bulan' : `${days} Hari`;

            addPremiumUser(targetUserId, days, price);

            await bot.sendMessage(targetUserId, `🎉 <b>SELAMAT! KAMU SEKARANG USER PREMIUM!</b>\n\n💎 <b>Keuntungan Premium:</b>\n✅ Cek bio unlimited\n✅ Pakai Sender Global tanpa batas\n\n📦 Package: ${packageName}\n💰 Harga: ${price}\n📅 Masa Aktif: ${new Date(Date.now() + days * 24 * 60 * 60 * 1000).toLocaleDateString('id-ID')}`).catch(() => {});

            await bot.editMessageText(
                `✅ User ${targetUserId} berhasil ditambahkan sebagai PREMIUM!\n\n📦 Package: ${packageName}\n💰 Harga: ${price}\n📅 Masa Aktif: ${new Date(Date.now() + days * 24 * 60 * 60 * 1000).toLocaleDateString('id-ID')}`,
                { chat_id: chat.id, message_id: message_id, parse_mode: 'HTML' }
            );
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'premium_cancel') {
            if (!isOwnerId(q.from.id)) {
                await bot.answerCallbackQuery(q.id, { text: '❌ Akses ditolak.' });
                return;
            }
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleManagePremium(chat.id);
            await bot.answerCallbackQuery(q.id);

        // === ADMIN: LIST SENDER ===
        } else if (q.data === 'admin_list_sender') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleListSenderGlobal(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_top_user') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleTopUser(chat.id, true);
            await bot.answerCallbackQuery(q.id);

        // === TRAFFIC ===
        } else if (q.data === 'refresh_traffic') {
            await handleTrafficCommand(chat.id);
            await bot.answerCallbackQuery(q.id);
        }
    } catch (e) {
        console.error("Callback Error:", e);
        bot.answerCallbackQuery(q.id, { text: "⚠️ Terjadi kesalahan.", show_alert: true }).catch(() => {});
    }
});

// ============================================================
// MESSAGE HANDLER
// ============================================================
bot.on('message', async (msg) => {
    if (!msg.text && !msg.document && !msg.photo && !msg.video) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isOwner = isOwnerId(userId);
    const text = msg.text || '';

    console.log(`📩 Pesan dari ${userId}: ${text.substring(0, 30)}`);

    const session = userSession.get(userId);

    // COMMAND /start
    if (text === '/start' || text.startsWith('/start ')) {
        if (!isPrivate(msg)) return;
        if (!(await checkAccess(msg))) return;
        userSession.delete(userId);
        await showMainMenu(chatId, msg.from.first_name || 'User', userId);
        return;
    }

    // WAITING CEK OTP
    if (session?.step === 'waiting_cek_otp') {
        if (!isPrivate(msg)) { userSession.delete(userId); return; }
        const phoneNumber = text.replace(/[^0-9]/g, '');
        if (!phoneNumber || phoneNumber.length < 5) {
            sendBQ(chatId, "❌ Nomor tidak valid. Masukkan minimal 5 digit.\n\nContoh: 628123456789");
            userSession.delete(userId);
            return;
        }
        const results = checkOtpByNumber(phoneNumber);
        if (results.length === 0) {
            sendBQ(chatId, `❌ Tidak ada OTP ditemukan untuk nomor: +${phoneNumber}`);
        } else {
            let textResult = `📋 <b>HASIL CEK OTP (1 jam terakhir)</b>\n━━━━━━━━━━━━━━━━━━━━━\n📱 +${phoneNumber}\nDitemukan ${results.length} OTP\n\n`;
            results.forEach((item, index) => {
                const flag = getCountryFlag(item.country || 'ID');
                const date = new Date(item.timestamp).toLocaleString('id-ID');
                textResult += `${index + 1}. ${flag} ${item.app}\n   🔑 <code>${item.otp}</code>\n   🕐 ${date}\n\n`;
            });
            sendBQ(chatId, textResult);
        }
        userSession.delete(userId);
        return;
    }

    // WAITING PAIRING WA
    if (session?.step === 'waiting_wa_pairing') {
        if (!isPrivate(msg)) { userSession.delete(userId); return; }
        const phoneNumber = text.replace(/[^0-9]/g, '');
        if (!phoneNumber || phoneNumber.length < 10) {
            sendBQ(chatId, "❌ Nomor tidak valid. Masukkan minimal 10 digit.\n\nContoh: 628123456789");
            return;
        }
        userSession.delete(userId);
        const status = getSenderStatus(userId);
        if (status === 'connected') { sendBQ(chatId, "✅ WhatsApp sudah terhubung!"); return; }
        const loadingMsg = await sendBQ(chatId, "⏳ Menghubungkan WhatsApp...\n\n<i>Mohon tunggu, ini bisa memakan waktu 10-30 detik.</i>");
        try {
            const result = await pairWhatsApp(userId, phoneNumber);
            if (result.success) {
                await bot.editMessageText(result.message, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' });
            } else {
                await bot.editMessageText(`❌ ${result.error}`, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' });
            }
        } catch (e) {
            console.error('❌ Error pairing:', e);
            await bot.editMessageText(`❌ Terjadi kesalahan: ${e.message}`, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' });
        }
        return;
    }

    // WAITING ADD PREMIUM - USER ID
    if (session?.step === 'waiting_premium_user') {
        if (!isOwner || !isPrivate(msg)) { userSession.delete(userId); return; }
        const targetUserId = text.replace(/[^0-9]/g, '');
        if (!targetUserId || !/^\d{5,20}$/.test(targetUserId)) {
            sendBQ(chatId, "❌ ID User tidak valid. Masukkan ID Telegram berupa angka.\n\nContoh: <code>123456789</code>");
            return;
        }

        userSession.set(userId, { step: 'waiting_premium_days', targetUserId });
        const existing = getPremiumUsers()[targetUserId];
        let info = `👤 <b>User ID:</b> <code>${targetUserId}</code>\n`;
        if (existing) {
            const exp = new Date(existing.expired);
            info += `⚠️ <b>Sudah premium</b> sampai ${exp.toLocaleString('id-ID')}.\n`;
            info += `Pilih paket di bawah untuk mengganti masa aktifnya.`;
        } else {
            info += `\nPilih paket premium:`;
        }

        await bot.sendMessage(chatId, info, { parse_mode: 'HTML', reply_markup: premiumPackageKeyboard(targetUserId) });
        return;
    }

    // WAITING ADD PREMIUM - PACKAGE DAYS (manual input fallback)
    if (session?.step === 'waiting_premium_days') {
        if (!isOwner || !isPrivate(msg)) { userSession.delete(userId); return; }
        const days = parseInt(text.trim(), 10);
        if (!PREMIUM_PACKAGE_DAYS.includes(days)) {
            sendBQ(chatId, `❌ Paket tidak tersedia. Gunakan salah satu: ${PREMIUM_PACKAGE_DAYS.join(', ')} hari.`);
            return;
        }
        const targetUserId = session.targetUserId;
        userSession.delete(userId);
        const price = getPrice(days);
        const keyboard = {
            inline_keyboard: [
                [{ text: `✅ KONFIRMASI ${days === 60 ? '2 BULAN' : days === 90 ? '3 BULAN' : days + ' HARI'}`, callback_data: `premium_confirm:${targetUserId}:${days}` }],
                [{ text: "❌ BATAL", callback_data: "premium_cancel" }]
            ]
        };
        await bot.sendMessage(chatId, `❓ <b>Konfirmasi Premium</b>\n\n👤 User ID: <code>${targetUserId}</code>\n📦 Paket: <b>${days} Hari</b>\n💰 Harga: <b>${price}</b>\n\nLanjutkan?`, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }

    // WAITING REMOVE PREMIUM
    if (session?.step === 'waiting_premium_remove') {
        if (!isOwner || !isPrivate(msg)) { userSession.delete(userId); return; }
        const targetUserId = text.replace(/[^0-9]/g, '');
        if (!targetUserId || !/^\d{5,20}$/.test(targetUserId)) {
            sendBQ(chatId, "❌ ID User tidak valid. Masukkan ID Telegram berupa angka.");
            return;
        }
        const removed = removePremiumUser(targetUserId);
        userSession.delete(userId);
        if (removed) {
            sendBQ(chatId, `✅ User <code>${targetUserId}</code> berhasil dihapus dari PREMIUM.`, { parse_mode: 'HTML' });
        } else {
            sendBQ(chatId, `❌ User <code>${targetUserId}</code> tidak ditemukan di daftar PREMIUM.`, { parse_mode: 'HTML' });
        }
        return;
    }

    // WAITING BROADCAST
    if (session?.step === 'waiting_broadcast') {
        if (!isOwner) { userSession.delete(userId); return; }
        const users = getUsers();
        if (users.length === 0) { sendBQ(chatId, "❌ Tidak ada user yang terdaftar."); userSession.delete(userId); return; }
        const sendMsg = await sendBQ(chatId, `📢 Mengirim broadcast ke ${users.length} user...`);
        let success = 0, failed = 0;
        for (const uid of users) {
            try {
                if (msg.text) await bot.sendMessage(uid, msg.text, { parse_mode: 'HTML' });
                else if (msg.document) await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption || '' });
                else if (msg.photo) await bot.sendPhoto(uid, msg.photo[0].file_id, { caption: msg.caption || '' });
                else if (msg.video) await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption || '' });
                success++;
            } catch (e) { failed++; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await bot.editMessageText(
            `✅ <b>Broadcast selesai!</b>\n\n📤 Terkirim: ${success} user\n❌ Gagal: ${failed} user`,
            { chat_id: chatId, message_id: sendMsg.message_id, parse_mode: 'HTML' }
        );
        userSession.delete(userId);
        return;
    }

    // OWNER: UPLOAD FILE STOK
    if (isOwner && msg.document) {
        const mimeType = msg.document.mime_type || '';
        const fileName = msg.document.file_name || 'unknown.txt';

        if (!mimeType.includes('text') && !fileName.toLowerCase().endsWith('.txt')) {
            sendBQ(chatId, "⚠️ Kirimkan file TXT, bukan file lain.");
            return;
        }

        let uploadMode = null;
        if (session?.step === 'waiting_add_stok_v2') uploadMode = 'v2';
        else if (session?.step === 'waiting_add_stok') uploadMode = 'v1';
        if (uploadMode) userSession.delete(userId);

        let batch = server2PendingUploads.get(userId);
        if (!batch || !Array.isArray(batch.files)) {
            batch = {
                files: [],
                timer: null,
                messageId: null,
                choiceMessageId: null,
                collecting: true,
                mode: uploadMode
            };
            server2PendingUploads.set(userId, batch);
        }

        if (batch.messageId && !batch.collecting) {
            batch = {
                files: [],
                timer: null,
                messageId: null,
                choiceMessageId: null,
                collecting: true,
                mode: uploadMode
            };
            server2PendingUploads.set(userId, batch);
        }

        if (uploadMode && batch.mode && batch.mode !== uploadMode && batch.files.length) {
            batch = {
                files: [],
                timer: null,
                messageId: null,
                choiceMessageId: null,
                collecting: true,
                mode: uploadMode
            };
            server2PendingUploads.set(userId, batch);
        }

        if (!batch.mode && uploadMode) batch.mode = uploadMode;
        batch.files.push({ fileId: msg.document.file_id, fileName });
        batch.collecting = true;

        if (batch.timer) clearTimeout(batch.timer);

        batch.timer = setTimeout(async () => {
            batch.timer = null;
            batch.collecting = false;

            const serverKeyboard = batch.mode ? {
                inline_keyboard: [
                    [{ text: '✅ UPLOAD SEMUA KE STOK', callback_data: 'upload_stok' }],
                    [{ text: '❌ BATAL SEMUA', callback_data: 'cancel_upload' }]
                ]
            } : {
                inline_keyboard: [
                    [{ text: '🟢 SERVER V1', callback_data: 'select_upload_mode:v1' }],
                    [{ text: '🔵 SERVER V2 / BASHA', callback_data: 'select_upload_mode:v2' }],
                    [{ text: '❌ BATAL', callback_data: 'cancel_upload' }]
                ]
            };

            let textConfirm = `<blockquote>📂 <b>FILE STOK DITERIMA</b>\n\n`;
            textConfirm += `📦 <b>${batch.files.length} file diterima sekaligus</b>\n\n`;
            batch.files.forEach((file, index) => {
                textConfirm += `${index + 1}. 📂 <code>${escapeHtmlV1(file.fileName)}</code>\n`;
            });

            if (batch.mode) {
                textConfirm += `\n🖥️ <b>Server tujuan:</b> ${batch.mode === 'v2' ? '🔵 V2 / Basha' : '🟢 V1'}`;
            } else {
                textConfirm += `\n📌 <b>Pilih server untuk semua file di atas:</b>`;
            }
            textConfirm += `</blockquote>`;

            try {
                const sent = await bot.sendMessage(chatId, textConfirm, {
                    parse_mode: 'HTML',
                    reply_markup: serverKeyboard
                });
                batch.messageId = sent.message_id;
                batch.choiceMessageId = sent.message_id;
            } catch (e) {
                console.error('Gagal mengirim pilihan/konfirmasi batch upload:', e);
                server2PendingUploads.delete(userId);
            }
        }, SERVER2_UPLOAD_BATCH_DELAY);

        return;
    }

    // COMMAND /addstok
    if (text.startsWith('/addstok')) {
        if (!isOwner) return;
        const args = text.split(' ');
        if (args.length > 1) {
            const countryName = args[1].toLowerCase().trim();
            userSession.set(userId, { step: 'waiting_add_stok', countryName: countryName });
            sendBQ(chatId, `📤 Kirim file TXT untuk negara <b>${countryName.toUpperCase()}</b>`);
        } else {
            sendBQ(chatId, "📤 Kirim file TXT stok yang ingin ditambahkan.");
        }
        return;
    }

    // OWNER COMMANDS
    if (isOwner) {
        if (text.startsWith('/listfile')) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
            if (files.length === 0) return sendBQ(chatId, "📂 Folder data kosong.");
            let responseText = "<b>📊 LIST STOK FILE:</b>\n\n";
            files.forEach(file => {
                const filePath = path.join(DATA_DIR, file);
                const stats = fs.statSync(filePath);
                const content = fs.readFileSync(filePath, 'utf8');
                const count = (content.match(/\d{9,15}/g) || []).length;
                const date = stats.birthtime.toLocaleDateString();
                const country = file.replace('.txt', '').toUpperCase();
                const flag = getCountryFlag(country);
                const name = getCountryName(country);
                responseText += `${flag} <b>${name}</b>\n├ 📦 ${count} nomor\n└ 📅 ${date}\n\n`;
            });
            const keyboard = { inline_keyboard: [[{ text: "✅ DONE", callback_data: "delete_message" }]] };
            const sent = await bot.sendMessage(chatId, responseText, { parse_mode: 'HTML', reply_markup: keyboard });
            lastBotMessage.set(chatId, sent.message_id);
            return;
        }
        if (text.startsWith('/delfile')) {
            const args = text.split(' ');
            if (args.length < 2) return sendBQ(chatId, "⚠️ Gunakan format: /delfile [NAMA_NEGARA]");
            const filePath = path.join(DATA_DIR, `${args[1].toLowerCase()}.txt`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                const flag = getCountryFlag(args[1]);
                const name = getCountryName(args[1]);
                sendBQ(chatId, `✅ File ${flag} <b>${name}</b> berhasil dihapus.`);
            } else sendBQ(chatId, "❌ File tidak ditemukan.");
            return;
        }
        if (text.startsWith('/listgroup')) {
            const groups = getGroups();
            if (groups.length === 0) return sendBQ(chatId, "📋 Daftar grup kosong.");
            let responseText = "📋 <b>Daftar Grup:</b>\n\n";
            groups.forEach((gid, index) => {
                responseText += `${index + 1}. ${gid}\n`;
            });
            sendBQ(chatId, responseText);
            return;
        }
        if (text.startsWith('/top')) {
            await handleTopUser(chatId, true);
            return;
        }
    }

    // PRIVATE CHAT MENU
    if (!isPrivate(msg)) return;
    if (!(await checkAccess(msg))) return;

    if (!isOwner) bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    if (lastBotMessage.has(chatId)) {
        bot.deleteMessage(chatId, lastBotMessage.get(chatId)).catch(() => {});
        lastBotMessage.delete(chatId);
    }

    userSession.delete(userId);

    switch (text) {
        case '☎️ GET NUMBER':
            showServerMenu(chatId);
            break;
        case '📂 GET FILE':
            handleGetFileMenu(chatId);
            break;
        case '🔍 CEK OTP':
            userSession.set(userId, { step: 'waiting_cek_otp' });
            sendBQ(chatId, "📱 Masukkan nomor yang ingin dicek.\n\nContoh: 628123456789");
            break;
        case '🛠️ LIST FITUR':
            showListFitur(chatId, userId);
            break;
        case '📊 TRAFFIC':
            handleTrafficCommand(chatId);
            break;
        case '💎 PREMIUM':
            await handlePremiumMenu(chatId, userId);
            break;
        case '➕ ADD WA':
            userSession.set(userId, { step: 'waiting_wa_pairing' });
            sendBQ(chatId, "📱 Masukkan nomor WhatsApp Anda.\n\nContoh: 628123456789");
            break;
        case '🗑️ HAPUS WA':
            const status = getSenderStatus(userId);
            if (status !== 'connected' && status !== 'pairing') {
                sendBQ(chatId, "❌ WhatsApp belum terhubung!");
                return;
            }
            const keyboard = {
                inline_keyboard: [
                    [{ text: "✅ Ya, Hapus", callback_data: "confirm_delete_wa" }],
                    [{ text: "❌ Tidak", callback_data: "cancel_delete_wa" }]
                ]
            };
            sendBQ(chatId, "⚠️ <b>Yakin ingin menghapus WhatsApp?</b>\n\nData session akan dihapus.", { reply_markup: keyboard });
            break;
        default:
            break;
    }
});

// Pulihkan sesi WhatsApp yang tersimpan setelah bot restart.
async function restoreExistingWASessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const users = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map(entry => entry.name);
    for (const uid of users) {
        try {
            await startWASession(Number(uid));
            await delay(500);
        } catch (e) {
            console.error(`❌ Gagal restore session ${uid}:`, e.message);
        }
    }
}
restoreExistingWASessions().catch(e => console.error('❌ Restore session error:', e));

// ============================================================
// STARTUP
// ============================================================
console.log("=================================");
console.log("🤖 Bot OTP Monitor started!");
console.log("📊 Bot running with Telegram Bot API");
console.log("=================================");
console.log(`API V1   : ${settings.API_URL}`);
console.log(`GROUP V1 : ${(getGroups() || []).join(', ') || '-'}`);
console.log("=================================");