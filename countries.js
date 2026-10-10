
const COUNTRY_OVERRIDE = {
    'CI': 'Pantai Gading', 'LA': 'Laos', 'CD': 'Kongo DR', 'CG': 'Kongo',
    'KP': 'Korea Utara', 'KR': 'Korea Selatan', 'RU': 'Rusia', 'US': 'Amerika Serikat',
    'GB': 'Inggris', 'DE': 'Jerman', 'NL': 'Belanda', 'AE': 'Uni Emirat Arab',
    'SA': 'Arab Saudi', 'CZ': 'Ceko', 'MK': 'Makedonia', 'VN': 'Vietnam',
    'TH': 'Thailand', 'PH': 'Filipina', 'IN': 'India', 'LK': 'Sri Lanka',
    'BD': 'Bangladesh', 'PK': 'Pakistan', 'NP': 'Nepal', 'SG': 'Singapura',
    'MY': 'Malaysia', 'ID': 'Indonesia', 'BO': 'Bolivia', 'VE': 'Venezuela',
    'EC': 'Ekuador', 'TT': 'Trinidad & Tobago', 'DO': 'Republik Dominika',
    'ST': 'Sao Tome', 'SZ': 'Eswatini', 'SS': 'Sudan Selatan', 'ZA': 'Afrika Selatan',
    'NZ': 'Selandia Baru', 'SB': 'Kepulauan Solomon', 'PG': 'Papua Nugini',
    'MH': 'Kepulauan Marshall', 'AZ': 'Azerbaijan', 'AM': 'Armenia',
    'KZ': 'Kazakhstan', 'KG': 'Kyrgyzstan', 'UZ': 'Uzbekistan', 'TJ': 'Tajikistan',
    'TM': 'Turkmenistan', 'GE': 'Georgia', 'CY': 'Siprus', 'TR': 'Turki',
    'IL': 'Israel', 'LB': 'Lebanon', 'PS': 'Palestina', 'SY': 'Suriah',
    'IQ': 'Irak', 'IR': 'Iran', 'YE': 'Yaman', 'JO': 'Yordania',
    'KW': 'Kuwait', 'QA': 'Qatar', 'BH': 'Bahrain', 'OM': 'Oman',
    'MV': 'Maladewa', 'BT': 'Bhutan', 'AF': 'Afghanistan', 'MN': 'Mongolia',
    'MM': 'Myanmar', 'KH': 'Kamboja', 'BN': 'Brunei', 'TL': 'Timor Leste'
};

const CODE_OVERRIDE = {
    'pantaigading': 'CI', 'pantai_gading': 'CI',
    'ivorycoast': 'CI', 'ivory_coast': 'CI',
    'ctedivoire': 'CI', 'cotedivoire': 'CI', 'cote_divoire': 'CI',
    'centralafricanrepublic': 'CF', 'central_african_republic': 'CF',
    'centralafricanrep': 'CF', 'republikafrikatengah': 'CF',
    'republik_afrika_tengah': 'CF', 'afrikatengah': 'CF', 'car': 'CF',
    'kongo': 'CG', 'kongodr': 'CD', 'kongo_dr': 'CD',
    'democraticrepublicofthecongo': 'CD', 'drcongo': 'CD', 'drc': 'CD',
    'republicofthecongo': 'CG', 'congobrazzaville': 'CG',
    'koreautara': 'KP', 'koreaselatan': 'KR',
    'northkorea': 'KP', 'southkorea': 'KR',
    'amerikaserikat': 'US', 'unitedstates': 'US', 'usa': 'US',
    'unitedstatesofamerica': 'US',
    'arabsaudi': 'SA', 'saudiarabia': 'SA',
    'uniemiratarab': 'AE', 'unitedarabemirates': 'AE', 'uae': 'AE',
    'srilanka': 'LK', 'sri_lanka': 'LK',
    'timorleste': 'TL', 'easttimor': 'TL',
    'myanmar': 'MM', 'burma': 'MM',
    'kamboja': 'KH', 'cambodia': 'KH',
    'laos': 'LA',
    'brunei': 'BN', 'bruneidarussalam': 'BN',
    'vietnam': 'VN', 'viet_nam': 'VN',
    'rusia': 'RU', 'russia': 'RU', 'russianfederation': 'RU',
    'suriah': 'SY', 'syria': 'SY',
    'mesir': 'EG', 'egypt': 'EG',
    'yaman': 'YE', 'yemen': 'YE',
    'belanda': 'NL', 'netherlands': 'NL', 'holland': 'NL',
    'inggris': 'GB', 'unitedkingdom': 'GB', 'uk': 'GB', 'greatbritain': 'GB',
    'jerman': 'DE', 'germany': 'DE',
    'belgia': 'BE', 'belgium': 'BE',
    'prancis': 'FR', 'france': 'FR',
    'italia': 'IT', 'italy': 'IT',
    'spanyol': 'ES', 'spain': 'ES',
    'portugal': 'PT',
    'yunani': 'GR', 'greece': 'GR',
    'turki': 'TR', 'turkey': 'TR',
    'swiss': 'CH', 'switzerland': 'CH',
    'austria': 'AT',
    'swedia': 'SE', 'sweden': 'SE',
    'norwegia': 'NO', 'norway': 'NO',
    'denmark': 'DK',
    'finlandia': 'FI', 'finland': 'FI',
    'polandia': 'PL', 'poland': 'PL',
    'ukraina': 'UA', 'ukraine': 'UA',
    'ceko': 'CZ', 'czech': 'CZ', 'czechia': 'CZ',
    'kanada': 'CA', 'canada': 'CA',
    'meksiko': 'MX', 'mexico': 'MX',
    'brasil': 'BR', 'brazil': 'BR',
    'argentina': 'AR',
    'chili': 'CL', 'chile': 'CL',
    'kolombia': 'CO', 'colombia': 'CO',
    'peru': 'PE',
    'venezuela': 'VE',
    'bolivia': 'BO',
    'paraguay': 'PY',
    'uruguay': 'UY',
    'ekuador': 'EC', 'ecuador': 'EC',
    'guyana': 'GY',
    'suriname': 'SR'
};

const COUNTRY_NAMES_CACHE = new Map();
let _regionNamesCache = null;

function _getRegionNames() {
    if (_regionNamesCache) return _regionNamesCache;
    try {
        const dn = new Intl.DisplayNames(['id'], { type: 'region' });
        _regionNamesCache = {};
        for (let i = 65; i <= 90; i++) {
            for (let j = 65; j <= 90; j++) {
                const code = String.fromCharCode(i, j);
                try {
                    const name = dn.of(code);
                    if (name && name !== code) {
                        _regionNamesCache[name.toLowerCase()] = code;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {
        _regionNamesCache = {};
    }
    return _regionNamesCache;
}

function getCountryCodeFromName(name) {
    if (!name) return '';
    let cleaned = String(name).toUpperCase().trim()
        .replace(/_NUMBERS$/i, '')
        .replace(/_NUM$/i, '')
        .replace(/_NOMOR$/i, '')
        .replace(/_STOK$/i, '')
        .trim();
    if (/^[A-Z]{2}$/.test(cleaned)) return cleaned;
    const variants = [
        cleaned.toLowerCase(),
        cleaned.toLowerCase().replace(/[^a-z]/g, ''),
        cleaned.toLowerCase().replace(/[^a-z]/g, '_'),
        cleaned.toLowerCase().replace(/_/g, ''),
        cleaned.toLowerCase().replace(/ /g, ''),
        cleaned.toLowerCase().replace(/\s+/g, '_'),
    ];
    for (const v of variants) {
        if (CODE_OVERRIDE[v]) return CODE_OVERRIDE[v];
    }
    const regions = _getRegionNames();
    for (const v of variants) {
        if (regions[v]) return regions[v];
    }
    try {
        const dn = new Intl.DisplayNames(['id'], { type: 'region' });
        const dnEn = new Intl.DisplayNames(['en'], { type: 'region' });
        for (let i = 65; i <= 90; i++) {
            for (let j = 65; j <= 90; j++) {
                const code = String.fromCharCode(i, j);
                try {
                    const nameId = (dn.of(code) || '').toLowerCase().replace(/[^a-z]/g, '');
                    const nameEn = (dnEn.of(code) || '').toLowerCase().replace(/[^a-z]/g, '');
                    if (nameId && variants.includes(nameId)) return code;
                    if (nameEn && variants.includes(nameEn)) return code;
                } catch (e) {}
            }
        }
    } catch (e) {}
    return cleaned;
}

function getCountryFlag(countryInput) {
    const code = getCountryCodeFromName(countryInput);
    if (!/^[A-Z]{2}$/.test(code)) return '🌍';
    return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
}

function getCountryName(countryInput) {
    const code = getCountryCodeFromName(countryInput);
    if (!code || code.length !== 2) return countryInput;
    if (COUNTRY_NAMES_CACHE.has(code)) return COUNTRY_NAMES_CACHE.get(code);
    if (COUNTRY_OVERRIDE[code]) {
        COUNTRY_NAMES_CACHE.set(code, COUNTRY_OVERRIDE[code]);
        return COUNTRY_OVERRIDE[code];
    }
    try {
        const dn = new Intl.DisplayNames(['id'], { type: 'region' });
        const name = dn.of(code) || countryInput;
        COUNTRY_NAMES_CACHE.set(code, name);
        return name;
    } catch (e) {
        return countryInput;
    }
}

module.exports = {
    COUNTRY_OVERRIDE,
    CODE_OVERRIDE,
    getCountryCodeFromName,
    getCountryFlag,
    getCountryName
};
