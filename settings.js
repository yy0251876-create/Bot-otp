// settings.js
module.exports = {
    // ============================================================
    // TELEGRAM BOT
    // ============================================================
    BOT_TOKEN: "8702451047:AAHfUoY-3Y_orsPO8NwpMtgND4xP_EPTuww",
    OWNER_ID: 1971362361,
    OWNER_ID_2: 0,

    // ============================================================
    // SERVER 1 — OTP API
    // ============================================================
    API_URL: "https://numberpanel.tech/api/otp?count=10",
    NUMBERPANEL_TOKEN: "_",
    NUMBERPANEL_URL: "https://numberpanel.tech",

    // ============================================================
    // SERVER 2 / V2 — BASHA
    // Nomor di countries_v2 harus sudah dialokasikan ke akun Basha.
    // Jangan commit token ke GitHub.
    // ============================================================
    BASHA_API_URL: "https://basha.cc/api/legacy/get-last-sms",
    BASHA_API_KEY: "bsh_mZLNviDhXo21jNLSgzru_Zg9qoAaX85K",
    BASHA_POLL_INTERVAL: 2000,

    // ============================================================
    // FORCE JOIN + LINK
    FORCE_JOIN: [
        { type: "group", name: "GRUP OTP", id: "@otpOrvinz", url: "https://t.me/otpOrvinz" },
        { type: "group", name: "GRUP MARKET", id: "@marketnokosmyid", url: "https://t.me/marketnokosmyid" },
        { type: "channel", name: "CH METODE", id: "@metodeneww", url: "https://t.me/metodeneww" },
        { type: "channel", name: "CH STOK FILE", id: "@allstokfile", url: "https://t.me/allstokfile" }
    ],
    GROUP_OTP_LINK: "https://t.me/otpOrvinz",
    NOTIF_CHANNEL: "@metodeneww",
    CHANNELS: ["@metodeneww", "@allstokfile"],
    GROUPS: ["@otpOrvinz", "@marketnokosmyid"],

    // AUTO DELETE
    // ============================================================
    AUTO_DELETE_HOURS: 24,
    DELETE_TIME: "00:00"
};
 
