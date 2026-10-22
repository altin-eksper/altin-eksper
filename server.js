const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
// Fotoğraflı taleplerin sunucuyu tıkamaması için 25 MB limit
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(__dirname));
// ================= CANLI PİYASA KUR MOTORU (CORS ENGELSİZ) =================
let cachedGoldPrices = {
    gramHas: 6725,
    updatedAt: new Date().toISOString()
};

async function fetchLiveGoldPriceFromSource() {
    try {
        // Uluslararası Ons ve USD/TRY üzerinden toptan has hesaplama
        const [resUsd, resGold] = await Promise.all([
            fetch('https://open.er-api.com/v6/latest/USD'),
            fetch('https://api.gold-api.com/price/XAU')
        ]);

        if (resUsd.ok && resGold.ok) {
            const dataUsd = await resUsd.json();
            const dataGold = await resGold.json();

            const usdTry = dataUsd?.rates?.TRY;
            const ounceUsd = parseFloat(dataGold.price);

            if (ounceUsd > 1000 && usdTry > 10) {
                // 1 Ons = 31.1034768 gram, 0.995 toptan has çarpanı
                const calculatedGram = (ounceUsd / 31.1034768) * usdTry * 0.995;
                if (calculatedGram > 1000) {
                    cachedGoldPrices.gramHas = Math.round(calculatedGram * 100) / 100;
                    cachedGoldPrices.updatedAt = new Date().toISOString();
                    console.log(`[Piyasa Kuru Güncellendi]: Has Gram: ${cachedGoldPrices.gramHas} TL`);
                }
            }
        }
    } catch (err) {
        console.error('[Canlı Kur Çekme Hatası]:', err.message);
    }
}

// Sunucu başlar başlamaz çek ve her 60 saniyede bir otomatik yenile
fetchLiveGoldPriceFromSource();
setInterval(fetchLiveGoldPriceFromSource, 60000);

// Ön yüzün sorunsuz çağıracağı yerel API rotası
app.get('/api/live-prices', (req, res) => {
    res.json({
        success: true,
        hasGram: cachedGoldPrices.gramHas,
        updatedAt: cachedGoldPrices.updatedAt
    });
});

// ================= GÜVENLİK & YÖNETİCİ ŞİFRESİ =================
const ADMIN_SECRET_KEY = process.env.ADMIN_KEY || 'Adali2026!';

function adminAuthMiddleware(req, res, next) {
    const providedKey = req.headers['x-admin-key'] || req.body?.adminKey;
    if (providedKey === ADMIN_SECRET_KEY) {
        return next();
    }
    return res.status(401).json({ success: false, message: 'Yetkisiz erişim. Geçerli yönetici şifresi gereklidir.' });
}

// Şifre doğrulama rotası
app.post('/api/admin/verify-auth', (req, res) => {
    const { adminKey } = req.body;
    if (adminKey === ADMIN_SECRET_KEY) {
        return res.json({ success: true, message: 'Giriş başarılı.' });
    }
    return res.status(401).json({ success: false, message: 'Geçersiz şifre.' });
});

// ================= AYARLAR & ADİL GELİR MOTORU =================
const TOKEN_UNIT_VALUE_TL = 30; 

// MESAYİ SAATLERİ KONTROLÜ (Haftanın 7 Günü: 09:00 - 18:00 Arası Aktif)
function isBusinessHours() {
    const now = new Date();
    // Türkiye saati UTC+3
    const utcHours = now.getUTCHours();
    const turkeyHours = (utcHours + 3) % 24;
    const turkeyMinutes = now.getUTCMinutes();

    const totalMinutes = turkeyHours * 60 + turkeyMinutes;
    const startMinutes = 9 * 60;  // 09:00
    const endMinutes = 18 * 60;   // 18:00

    return (totalMinutes >= startMinutes && totalMinutes < endMinutes);
}

// Ürün bazlı dinamik başarı komisyonu hesaplama fonksiyonu
// KURAL: Bilezik, 22k Hurda ve 24k Gram için Binde 1 (0.001); diğer ürünler için Binde 2 (0.002)
function calculateDealCommissionAndTokens(items, agreedPrice) {
    const finalPrice = Number(agreedPrice) || 0;
    if (finalPrice <= 0) return { commissionTL: 0, tokens: 2, appliedRateText: '‰2' };

    let totalCommissionTL = 0;
    let appliedRateText = '‰2';

    if (!items || !Array.isArray(items) || items.length === 0) {
        totalCommissionTL = finalPrice * 0.002;
        appliedRateText = '‰2';
    } else {
        let totalReferenceVal = 0;
        items.forEach(it => {
            const val = parseFloat(String(it.amount || '0').replace(/[^0-9,]/g, '').replace(',', '.')) || 0;
            totalReferenceVal += val;
        });

        let weightedRateSum = 0;

        items.forEach(it => {
            const itVal = parseFloat(String(it.amount || '0').replace(/[^0-9,]/g, '').replace(',', '.')) || 0;
            const itemRatio = totalReferenceVal > 0 ? (itVal / totalReferenceVal) : (1 / items.length);
            const itemRealTL = finalPrice * itemRatio;

            const pCode = String(it.productCode || '').toLowerCase().trim();
            const karat = String(it.karat || '').trim();

            // Binde 1 (‰1) Kriteri: Bilezik, 22k Hurda, 24k Gram Has
            const isBindeBir = (pCode === 'bracelet') || 
                               (pCode === 'scrap' && karat === '22') || 
                               (pCode === 'gram' && karat === '24');

            const rate = isBindeBir ? 0.001 : 0.002;
            weightedRateSum += (rate * itemRatio);
            totalCommissionTL += (itemRealTL * rate);
        });

        appliedRateText = weightedRateSum <= 0.0012 ? '‰1' : (weightedRateSum >= 0.0018 ? '‰2' : '‰1 - ‰2 (Karma)');
    }

    let tokens = Math.ceil(totalCommissionTL / TOKEN_UNIT_VALUE_TL);

    const MIN_TOKENS = 1;  
    const MAX_TOKENS = 50; 

    if (tokens < MIN_TOKENS) tokens = MIN_TOKENS;
    if (tokens > MAX_TOKENS) tokens = MAX_TOKENS;

    return {
        commissionTL: Math.round(totalCommissionTL),
        tokens: tokens,
        appliedRateText: appliedRateText
    };
}

// ================= KALICI VERİTABANI MOTORU =================
const DB_FILE = path.join(__dirname, 'database.json');

const INITIAL_JEWELERS = [
    {
        id: 'SARRAF_01',
        name: 'Güneş Sarrafiye',
        city: 'Antalya',
        districts: ['Muratpaşa'],
        phone: '905399321893',
        address: 'Işıklar Cad. No:14 Muratpaşa / Antalya',
        membershipType: 'token',
        credits: 50,
        subscriptionExpiresAt: null,
        status: 'ACTIVE'
    },
    {
        id: 'SARRAF_02',
        name: 'Karat Mücevherat',
        city: 'Antalya',
        districts: ['Kepez'],
        phone: '905399321893',
        address: 'Dokuma Çallı Meydanı No:5 Kepez / Antalya',
        membershipType: 'subscription',
        credits: 0,
        subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'ACTIVE'
    },
    {
        id: 'SARRAF_03',
        name: 'Akdeniz Kuyumculuk',
        city: 'Antalya',
        districts: ['Muratpaşa', 'Kepez', 'Konyaaltı'],
        phone: '905399321893',
        address: 'Atatürk Bulvarı No:88 Muratpaşa / Antalya',
        membershipType: 'token',
        credits: 50,
        subscriptionExpiresAt: null,
        status: 'ACTIVE'
    }
];

function sanitizeJewelers(list) {
    if (!Array.isArray(list)) return INITIAL_JEWELERS;
    
    list.forEach((j, idx) => {
        if (!j.id) {
            j.id = j.code || ('SARRAF_' + String(idx + 1).padStart(2, '0'));
        }
        if (j.credits === undefined || j.credits === null) {
            j.credits = 0;
        }
        if (!j.membershipType) {
            j.membershipType = 'token';
        }
        if (!j.status) {
            j.status = 'ACTIVE';
        }
    });

    const hasGunes = list.some(j => (j.name && j.name.toLowerCase().includes('güneş')) || j.id === 'SARRAF_01');
    if (!hasGunes) {
        list.unshift(INITIAL_JEWELERS[0]);
    }

    return list;
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = {
                jewelers: INITIAL_JEWELERS,
                completedDeals: [],
                pendingPayments: [],
                activeRequests: []
            };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
            return initialData;
        }
        const fileContent = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(fileContent);
        parsed.jewelers = sanitizeJewelers(parsed.jewelers);
        parsed.completedDeals = parsed.completedDeals || [];
        parsed.pendingPayments = parsed.pendingPayments || [];
        parsed.activeRequests = parsed.activeRequests || [];
        return parsed;
    } catch (e) {
        console.error('[DB Yükleme Hatası]:', e);
        return { jewelers: INITIAL_JEWELERS, completedDeals: [], pendingPayments: [], activeRequests: [] };
    }
}

function saveDatabase() {
    try {
        const payload = {
            jewelers: JEWELERS_DIRECTORY,
            completedDeals: completedDeals,
            pendingPayments: pendingPayments,
            activeRequests: requestsPool
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
        console.error('[DB Kaydetme Hatası]:', e);
    }
}

const persistedData = loadDatabase();
let JEWELERS_DIRECTORY = persistedData.jewelers || INITIAL_JEWELERS;
let completedDeals = persistedData.completedDeals || [];
let pendingPayments = persistedData.pendingPayments || [];
let requestsPool = persistedData.activeRequests || [];

saveDatabase();

// ================= META WHATSAPP CLOUD API AYARLARI =================
const WHATSAPP_CONFIG = {
    phoneNumberId: '1276539392206823',
    accessToken: 'EAAY3ClF5SXgBSgKOGZAf4f2hIzEYFjjbLMmOpQ790tWqSYKnFCrCpKUgp8It3BAAPZCXhIGpIXWHlz0MhOd2ZCeE7tWxyOlUc9rGH0QbOyFpnvNZCIZAbtpVOa4NOZBg9DKrWUOd6MfqXPttArAyeAkzUc6dN9GyfmWWSR0eBoJnt95qMdR65QDRtHZC4hOWzi47QZDZD',
    apiVersion: 'v21.0',
    adminPhone: '905399321893'
};

async function sendWhatsAppMessage(toPhone, messageText) {
    if (!toPhone || !WHATSAPP_CONFIG.accessToken) return null;

    let cleanPhone = toPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '90' + cleanPhone.substring(1);
    if (cleanPhone.length === 10) cleanPhone = '90' + cleanPhone;

    const url = `https://graph.facebook.com/${WHATSAPP_CONFIG.apiVersion}/${WHATSAPP_CONFIG.phoneNumberId}/messages`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanPhone,
                type: 'text',
                text: { preview_url: true, body: messageText }
            })
        });

        const data = await response.json();
        console.log(`[WhatsApp API Sonucu -> ${cleanPhone}]:`, JSON.stringify(data));
        return data;
    } catch (err) {
        console.error('[WhatsApp Gönderim Hatası]:', err);
        return null;
    }
}

// Süresi dolan (15 dk) talepleri otomatik takip ve teklif alamayan müşteriyi bilgilendirme
setInterval(async () => {
    const now = Date.now();
    for (const r of requestsPool) {
        if (r.status === 'PENDING' && r.expiresAt && new Date(r.expiresAt).getTime() <= now) {
            r.status = 'EXPIRED';
            saveDatabase();
            if ((!r.quotes || r.quotes.length === 0) && r.customerPhone && !r.hasExpiredNotified) {
                r.hasExpiredNotified = true;
                const expiredMsg = 
`ℹ️ *Altın Eksper Bilgilendirmesi:*

Sayın *${r.customerName || 'Müşterimiz'}*, #${r.requestId} nolu altın satış talebiniz için bölgenizdeki sarraflar şu an dükkan içi yoğunluk nedeniyle ilk 15 dakikada teklif iletemedi.

Talebiniz kayıtlı sarraflarımıza açık tutulmaya devam etmektedir. İlk teklif verildiğinde WhatsApp hattınızdan anında bilgilendirileceksiniz.`;

                await sendWhatsAppMessage(r.customerPhone, expiredMsg);
            }
        }
    }

    requestsPool = requestsPool.filter(r => r.status === 'APPOINTMENT_SET' || !r.expiresAt || new Date(r.expiresAt).getTime() > now);
    saveDatabase();
}, 30000);

// Ana Sayfa & Yönetim Rotası
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ================= KUYUMCU ÜYELİK & BAKİYE YÖNETİMİ =================

app.post('/api/jeweler/apply', async (req, res) => {
    try {
        const { firmName, phone, city, district, planType } = req.body;
        if (!firmName || !phone) {
            return res.status(400).json({ success: false, message: 'Firma adı ve telefon zorunludur.' });
        }

        const newId = 'SARRAF_' + String(Date.now()).slice(-4);
        const WELCOME_BONUS_CREDITS = 10;

        const newJeweler = {
            id: newId,
            name: firmName,
            city: city || 'Antalya',
            districts: district ? [district] : ['Muratpaşa'],
            phone: phone,
            address: `${district || 'Merkez'} / ${city || 'Antalya'}`,
            membershipType: planType === 'subscription' ? 'subscription' : 'token',
            credits: WELCOME_BONUS_CREDITS,
            subscriptionExpiresAt: null,
            status: 'ACTIVE'
        };

        JEWELERS_DIRECTORY.push(newJeweler);
        saveDatabase();

        const adminAlert = 
`💼 *YENİ KUYUMCU KAYDI (10 HEDİYE JETONLU)!*

🏢 *Firma:* ${firmName}
📞 *Telefon:* ${phone}
📍 *Bölge:* ${city || 'Antalya'} / ${district || 'Muratpaşa'}
🎁 *Başlangıç Hediyesi:* ${WELCOME_BONUS_CREDITS} İhale Jetonu Tanımlandı
🆔 *Kuyumcu Kodu:* ${newId}

Esnaf şu an aktif ve bölgedeki yeni ihalelere anında teklif verebilir.`;

        await sendWhatsAppMessage(WHATSAPP_CONFIG.adminPhone, adminAlert);

        const jewelerWelcomeMsg = 
`🎉 *ALTIN EKSPER AİLESİNE HOŞ GELDİNİZ!*

Sayın *${firmName}*, sistem kaydınız başarıyla tamamlandı.

🆔 *Sarraf Kodunuz:* ${newId}
🎁 *Pilot Hediye Bakiyeniz:* ${WELCOME_BONUS_CREDITS} İhale Jetonu

Bölgenizdeki müşteriler altın satmak istediğinde WhatsApp üzerinden canlı ihale bildirimleri almaya başlayacaksınız. Bol kazançlar dileriz!`;

        await sendWhatsAppMessage(phone, jewelerWelcomeMsg);

        res.json({ 
            success: true, 
            message: `Kaydınız alındı! Hesabınıza ${WELCOME_BONUS_CREDITS} deneme jetonu tanımlandı.`,
            jewelerId: newId 
        });
    } catch (err) {
        console.error('Kuyumcu başvuru hatası:', err);
        res.status(500).json({ success: false, message: 'Başvuru alınamadı.' });
    }
});

app.post('/api/admin/jeweler/topup', adminAuthMiddleware, (req, res) => {
    const { jewelerId, addCredits, extendDays, activate } = req.body;
    
    if (!jewelerId) {
        return res.status(400).json({ success: false, message: 'Kuyumcu kimliği belirtilmedi.' });
    }

    const searchKey = String(jewelerId).trim().toLowerCase();
    const jeweler = JEWELERS_DIRECTORY.find(j => {
        const idMatch = j.id && String(j.id).trim().toLowerCase() === searchKey;
        const codeMatch = j.code && String(j.code).trim().toLowerCase() === searchKey;
        const nameMatch = j.name && String(j.name).trim().toLowerCase() === searchKey;
        return idMatch || codeMatch || nameMatch;
    });

    if (!jeweler) {
        return res.status(404).json({ success: false, message: 'Kuyumcu bulunamadı.' });
    }

    if (activate) jeweler.status = 'ACTIVE';

    if (addCredits !== undefined && addCredits !== null) {
        jeweler.membershipType = 'token';
        jeweler.credits = Math.max(0, (Number(jeweler.credits) || 0) + Number(addCredits));
    }

    if (extendDays) {
        jeweler.membershipType = 'subscription';
        const now = new Date();
        const baseDate = (jeweler.subscriptionExpiresAt && new Date(jeweler.subscriptionExpiresAt) > now)
            ? new Date(jeweler.subscriptionExpiresAt)
            : now;
        baseDate.setDate(baseDate.getDate() + Number(extendDays));
        jeweler.subscriptionExpiresAt = baseDate.toISOString();
    }

    saveDatabase();
    res.json({ success: true, message: 'Kuyumcu hesabı güncellendi.', jeweler });
});

app.get('/api/jeweler/status/:id', (req, res) => {
    const searchId = String(req.params.id).trim().toLowerCase();
    const jeweler = JEWELERS_DIRECTORY.find(j => 
        (j.id && String(j.id).trim().toLowerCase() === searchId) || 
        (j.code && String(j.code).trim().toLowerCase() === searchId) || 
        (j.name && String(j.name).trim().toLowerCase() === searchId)
    );

    if (!jeweler) return res.status(404).json({ success: false, message: 'Kuyumcu bulunamadı.' });

    res.json({
        success: true,
        data: {
            id: jeweler.id,
            name: jeweler.name,
            status: jeweler.status,
            membershipType: jeweler.membershipType,
            credits: jeweler.credits,
            subscriptionExpiresAt: jeweler.subscriptionExpiresAt,
            address: jeweler.address || ''
        }
    });
});

app.get('/api/jeweler/deals/:id', (req, res) => {
    const searchId = String(req.params.id).trim().toLowerCase();
    const jeweler = JEWELERS_DIRECTORY.find(j => 
        (j.id && String(j.id).trim().toLowerCase() === searchId) || 
        (j.code && String(j.code).trim().toLowerCase() === searchId) || 
        (j.name && String(j.name).trim().toLowerCase() === searchId)
    );

    if (!jeweler) {
        return res.status(404).json({ success: false, message: 'Kuyumcu bulunamadı.' });
    }

    const myDeals = completedDeals.filter(d => {
        const dJewelerId = String(d.jewelerId || '').trim().toLowerCase();
        const dJewelerName = String(d.jewelerName || '').trim().toLowerCase();
        return dJewelerId === searchId || 
               (jeweler.id && dJewelerId === String(jeweler.id).toLowerCase()) ||
               (jeweler.code && dJewelerId === String(jeweler.code).toLowerCase()) ||
               (jeweler.name && dJewelerName === String(jeweler.name).toLowerCase());
    });

    res.json({ 
        success: true, 
        jeweler: {
            id: jeweler.id,
            name: jeweler.name,
            credits: jeweler.credits,
            membershipType: jeweler.membershipType
        },
        deals: myDeals 
    });
});

app.get('/api/admin/jewelers', adminAuthMiddleware, (req, res) => {
    res.json({ success: true, jewelers: JEWELERS_DIRECTORY });
});

app.get('/api/jewelers', (req, res) => {
    res.json({ success: true, jewelers: JEWELERS_DIRECTORY });
});

// ================= ÖDEME & JETON SATIN ALMA ALTYAPISI =================

app.post('/api/jeweler/purchase-package', async (req, res) => {
    try {
        const { jewelerId, packageId, paymentMethod, senderName, note } = req.body;
        const searchKey = String(jewelerId).trim().toLowerCase();
        const jeweler = JEWELERS_DIRECTORY.find(j => 
            (j.id && String(j.id).trim().toLowerCase() === searchKey) ||
            (j.code && String(j.code).trim().toLowerCase() === searchKey) ||
            (j.name && String(j.name).trim().toLowerCase() === searchKey)
        );

        if (!jeweler) {
            return res.status(404).json({ success: false, message: 'Kuyumcu kaydı bulunamadı.' });
        }

        const packageNames = {
            token_25: '25 İhale Jetonu (750 TL)',
            token_75: '75 Avantaj Jetonu (1.750 TL)',
            subscription_vip: '30 Gün Sınırsız VIP (3.500 TL)'
        };

        const newOrder = {
            orderId: 'ORD_' + Date.now().toString().slice(-6),
            jewelerId: jeweler.id,
            jewelerName: jeweler.name,
            jewelerPhone: jeweler.phone,
            packageId: packageId,
            packageName: packageNames[packageId] || packageId,
            paymentMethod: paymentMethod || 'HAVALE',
            senderName: senderName || jeweler.name,
            note: note || '',
            createdAt: new Date().toISOString(),
            status: 'PENDING_APPROVAL'
        };

        pendingPayments.unshift(newOrder);
        saveDatabase();

        const paymentAlert = 
`💳 *YENİ PAKET / JETON ÖDEME BİLDİRİMİ!*

🏪 *Kuyumcu:* ${jeweler.name} (${jeweler.id})
📦 *Paket:* ${newOrder.packageName}
👤 *Ödeme Yapan (Dekont İsim):* ${newOrder.senderName}
🎟️ *Sipariş No:* #${newOrder.orderId}

Admin panelinden ödemeyi teyit edip tek tıkla onaylayabilirsiniz.`;

        await sendWhatsAppMessage(WHATSAPP_CONFIG.adminPhone, paymentAlert);

        res.json({
            success: true,
            message: 'Ödeme bildiriminiz alındı. Yönetici teyidinden sonra bakiyeniz otomatik yüklenecektir.',
            order: newOrder
        });
    } catch (err) {
        console.error('Ödeme bildirim hatası:', err);
        res.status(500).json({ success: false, message: 'Ödeme bildirimi işlenemedi.' });
    }
});

app.get('/api/admin/payments', adminAuthMiddleware, (req, res) => {
    res.json({ success: true, payments: pendingPayments });
});

app.post('/api/admin/payment/approve', adminAuthMiddleware, async (req, res) => {
    try {
        const { orderId } = req.body;
        const order = pendingPayments.find(p => p.orderId === orderId);

        if (!order) {
            return res.status(404).json({ success: false, message: 'Sipariş bulunamadı.' });
        }

        const jeweler = JEWELERS_DIRECTORY.find(j => j.id === order.jewelerId || j.name === order.jewelerName);
        if (!jeweler) {
            return res.status(404).json({ success: false, message: 'İlgili kuyumcu hesabı bulunamadı.' });
        }

        jeweler.status = 'ACTIVE';

        if (order.packageId === 'token_25') {
            jeweler.membershipType = 'token';
            jeweler.credits = (Number(jeweler.credits) || 0) + 25;
        } else if (order.packageId === 'token_75') {
            jeweler.membershipType = 'token';
            jeweler.credits = (Number(jeweler.credits) || 0) + 75;
        } else if (order.packageId === 'subscription_vip') {
            jeweler.membershipType = 'subscription';
            const now = new Date();
            const baseDate = (jeweler.subscriptionExpiresAt && new Date(jeweler.subscriptionExpiresAt) > now)
                ? new Date(jeweler.subscriptionExpiresAt)
                : now;
            baseDate.setDate(baseDate.getDate() + 30);
            jeweler.subscriptionExpiresAt = baseDate.toISOString();
        }

        order.status = 'APPROVED';
        saveDatabase();

        const approvalNotice = 
`✅ *ÖDEMENİZ ONAYLANDI & BAKİYENİZ YÜKLENDİ!*

Sayın *${jeweler.name}*, #${order.orderId} nolu siparişiniz onaylandı.
📦 Tanımlanan Paket: ${order.packageName}
${jeweler.membershipType === 'token' ? `🪙 Yeni Jeton Bakiyeniz: ${jeweler.credits}` : `👑 VIP Abonelik Bitiş: ${new Date(jeweler.subscriptionExpiresAt).toLocaleDateString('tr-TR')}`}

Bölgenizdeki tüm yeni ihalelere hemen teklif vermeye başlayabilirsiniz. Bol kazançlar dileriz!`;

        await sendWhatsAppMessage(jeweler.phone, approvalNotice);

        res.json({ success: true, message: 'Ödeme onaylandı, bakiye sarrafa tanımlandı.', jeweler });
    } catch (err) {
        console.error('Ödeme onay hatası:', err);
        res.status(500).json({ success: false, message: 'Ödeme onaylanamadı.' });
    }
});

// ================= İHALE & TEKLİF YÖNETİMİ =================

app.post('/api/request/create', async (req, res) => {
    try {
        const reqData = req.body;
        if (!reqData || !reqData.requestId) {
            return res.status(400).json({ success: false, message: 'Geçersiz talep verisi' });
        }

        // MESAYİ KONTROLÜ (09:00 - 18:00)
        const openNow = isBusinessHours();
        reqData.isOffHours = !openNow;
        reqData.status = 'PENDING';
        reqData.quotes = [];

        // Talebi hemen havuza al ve kalıcı database.json dosyasına yaz
        requestsPool.unshift(reqData);
        saveDatabase();

        // Mesai saati dışındaysa sarraflara gece mesaj atılmaz
        if (!openNow) {
            if (reqData.customerPhone) {
                const offHourMsg = `🌙 *Altın Eksper:* #${reqData.requestId} nolu talebiniz alındı. Sarraflarımız şu an mesai saatleri dışındadır (Çalışma: Haftanın 7 Günü 09:00 - 18:00). Talebiniz sabah 09:00'da canlı ihaleye açılacak ve teklifler toplanacaktır.`;
                await sendWhatsAppMessage(reqData.customerPhone, offHourMsg);
            }
            return res.json({ 
                success: true, 
                offHours: true,
                message: 'Talebiniz kaydedildi. Sarraf çalışma saatleri dışında olduğundan sabah 09:00\'da ihaleye açılacaktır.', 
                requestId: reqData.requestId 
            });
        }

        const targetDistrictRaw = (reqData.district || '').trim().toLowerCase();

        // İlçeye veya aktifliğe göre kuyumcuları eşle
        let matchedJewelers = JEWELERS_DIRECTORY.filter(j => {
            if (j.status !== 'ACTIVE') return false;
            if (!targetDistrictRaw) return true;
            return j.districts && j.districts.some(d => {
                const cleanD = d.toLowerCase();
                return targetDistrictRaw.includes(cleanD) || cleanD.includes(targetDistrictRaw);
            });
        });

        // İlçe tam eşleşmezse tüm aktif sarraflara gönder
        if (matchedJewelers.length === 0) {
            matchedJewelers = JEWELERS_DIRECTORY.filter(j => j.status === 'ACTIVE');
        }

        const itemsList = (reqData.items || []).map(it => 
            `• ${it.productName} (${it.karat}k) - ${it.grams ? it.grams + 'g' : ''} ${it.qty ? it.qty + ' adet' : ''}`
        ).join('\n');

        console.log(`[Dağıtım]: #${reqData.requestId} için ${matchedJewelers.length} sarrafa WhatsApp gönderiliyor...`);

        for (const jeweler of matchedJewelers) {
            const offerLink = `https://altin-eksper.onrender.com/kuyumcu.html?req=${reqData.requestId}&jeweler=${jeweler.id}`;

            const remainingInfo = jeweler.membershipType === 'token' 
                ? `🪙 Kalan Teklif Hakkınız: ${jeweler.credits}`
                : `📅 Paket Durumu: Aktif Abonelik`;

            const jewelerNotification = 
`🔔 *ALTIN EKSPER — BÖLGENİZDE YENİ İHALE!*

Sayın *${jeweler.name}*, bölgenizde nakit altın satmak isteyen yeni bir müşteri ihalesi başladı.

🏷 *Talep No:* #${reqData.requestId}
📍 *Konum:* ${reqData.city || 'Antalya'} / ${reqData.district}
⚖️ *Toplam Ağırlık:* ${reqData.totalGrams || '0 g'}
💰 *Referans Değer:* ${reqData.totalReferenceTL || '0 ₺'}
${remainingInfo}

📦 *Müşterinin Altınları:*
${itemsList}

⏱ *Kalan Teklif Süresi:* 15 Dakika
👉 *Hemen Teklif Verin:* ${offerLink}`;

            await sendWhatsAppMessage(jeweler.phone, jewelerNotification);
        }

        if (reqData.customerPhone) {
            const customerMsg = `✅ *Altın Eksper:* #${reqData.requestId} nolu satış talebiniz kayıtlı sarraflara iletildi. Teklifler toplanıyor, 15 dakika içinde en iyi teklif size bildirilecektir.`;
            await sendWhatsAppMessage(reqData.customerPhone, customerMsg);
        }

        res.json({ 
            success: true, 
            message: `İhale açıldı, ${matchedJewelers.length} aktif sarrafa WhatsApp iletildi.`, 
            requestId: reqData.requestId 
        });
    } catch (error) {
        console.error('Create error:', error);
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

app.get('/api/requests', (req, res) => {
    const now = Date.now();
    const active = requestsPool.filter(r => r.status === 'APPOINTMENT_SET' || !r.expiresAt || new Date(r.expiresAt).getTime() > now);
    res.json({ success: true, requests: active });
});

app.get('/api/request/:id', (req, res) => {
    const searchId = String(req.params.id).trim();
    const found = requestsPool.find(r => String(r.requestId).trim() === searchId);
    if (!found) {
        return res.status(404).json({ success: false, message: 'Talep bulunamadı' });
    }
    res.json({ success: true, data: found });
});

// ================= TEKLİF VERME & REVİZE ETME =================
app.post('/api/request/quote', (req, res) => {
    const { requestId, jewelerCode, offerPrice, note } = req.body;
    console.log(`[Teklif Girişi]: #${requestId} için ${jewelerCode} -> ${offerPrice} TL`);

    const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
    if (!target) {
        return res.status(404).json({ success: false, message: 'İhale süresi dolmuş veya bulunamadı.' });
    }

    const searchKey = String(jewelerCode).trim().toLowerCase();
    const jeweler = JEWELERS_DIRECTORY.find(j => 
        (j.id && String(j.id).trim().toLowerCase() === searchKey) || 
        (j.code && String(j.code).trim().toLowerCase() === searchKey) || 
        (j.name && String(j.name).trim().toLowerCase() === searchKey)
    );

    if (jeweler && jeweler.status !== 'ACTIVE') {
        return res.status(403).json({ success: false, message: 'Üyeliğiniz aktif değil.' });
    }

    target.quotes = target.quotes || [];
    const idx = target.quotes.findIndex(q => {
        const qCode = String(q.jewelerCode).trim().toLowerCase();
        return qCode === searchKey || (jeweler && qCode === String(jeweler.id).toLowerCase());
    });

    if (idx !== -1) {
        target.quotes[idx] = { 
            jewelerCode: jeweler ? jeweler.id : jewelerCode, 
            offerPrice: Number(offerPrice), 
            note: note || target.quotes[idx].note,
            updatedAt: new Date().toISOString()
        };
        console.log(`[Teklif Revize Edildi]: ${jewelerCode} yeni teklif: ${offerPrice} TL`);
    } else {
        if (jeweler && jeweler.membershipType === 'token') {
            if ((jeweler.credits || 0) <= 0) {
                return res.status(403).json({ success: false, message: 'Yetersiz bakiye! Teklif vermek için paket yenileyin.' });
            }
            jeweler.credits -= 1;
            console.log(`[Bakiye Düştü]: ${jeweler.name} teklif için 1 jeton harcadı. Kalan jeton: ${jeweler.credits}`);
        }

        target.quotes.push({ 
            jewelerCode: jeweler ? jeweler.id : jewelerCode, 
            offerPrice: Number(offerPrice), 
            note, 
            createdAt: new Date().toISOString() 
        });
    }

    saveDatabase();

    res.json({ 
        success: true, 
        quotes: target.quotes, 
        remainingCredits: jeweler ? jeweler.credits : null 
    });
});

// ================= 1. ADIM: MÜŞTERİ SEÇTİĞİNDE 4 HANELİ PIN ÜRETİLİR & RANDEVU OLUŞTURULUR =================
app.post('/api/request/notify-winner', async (req, res) => {
    try {
        const { requestId, jewelerCode, agreedPrice, customerName, customerPhone } = req.body;
        const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
        const finalPrice = Number(agreedPrice) || 0;
        
        const securityPin = String(Math.floor(1000 + Math.random() * 9000));

        if (target) {
            target.status = 'APPOINTMENT_SET'; 
            target.winnerCode = jewelerCode;
            target.agreedPrice = finalPrice;
            target.securityPin = securityPin;
            saveDatabase();
            console.log(`[Randevu Kesildi]: #${requestId} kazanan: ${jewelerCode} | PIN: ${securityPin} | Ön Tutar: ${finalPrice.toLocaleString('tr-TR')} TL`);
        }

        const searchKey = String(jewelerCode).trim().toLowerCase();
        const targetJeweler = JEWELERS_DIRECTORY.find(j => 
            (j.id && String(j.id).trim().toLowerCase() === searchKey) || 
            (j.code && String(j.code).trim().toLowerCase() === searchKey) || 
            (j.name && String(j.name).trim().toLowerCase() === searchKey)
        );

        const jewelerPhone = targetJeweler ? targetJeweler.phone : WHATSAPP_CONFIG.adminPhone;
        const jewelerName = targetJeweler ? targetJeweler.name : jewelerCode;
        const jewelerAddress = (targetJeweler && targetJeweler.address) ? targetJeweler.address : 'Muratpaşa / Antalya';
        const mapUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(jewelerAddress);

        const finishUrl = `https://altin-eksper.onrender.com/kuyumcu.html?req=${requestId}&jeweler=${targetJeweler ? targetJeweler.id : jewelerCode}`;

        const winnerMessage = 
`🎉 *YENİ İŞLEM RANDEVUSU OLUŞTURULDU!*

Sayın *${jewelerName}*, verdiğiniz teklif müşteri tarafından seçildi!

🏷 *Talep No:* #${requestId}
👤 *Müşteri Adı:* ${customerName || 'Müşteri'}
💰 *Ön Teklif Tutarı:* ${finalPrice.toLocaleString('tr-TR')} ₺
📌 *Müşteri İletişim:* ${customerPhone || 'Girilmedi'}

🔒 *Güvenlik Şifresi:* Müşteri dükkanınıza geldiğinde telefonundaki 4 haneli *Güvenlik Kodunu* isteyiniz. İşlemi kapatırken bu kodu girmeniz gerekecektir.
Müşteri gelip tartım yapılana kadar başarı komisyonu jetonunuz *düşmez*.

👉 *İşlem Paneli:* ${finishUrl}`;

        await sendWhatsAppMessage(jewelerPhone, winnerMessage);

        if (customerPhone) {
            const customerAppointmentMsg = 
`✨ *ALTIN EKSPER — İŞLEM RANDEVUNUZ HAZIR*

Sayın *${customerName || 'Müşterimiz'}*, altın satış işleminiz için randevunuz oluşturuldu.

🏪 *Yetkili Sarraf:* ${jewelerName}
💰 *Taahhüt Edilen Tutar:* ${finalPrice.toLocaleString('tr-TR')} ₺
📍 *Mağaza Adresi:* ${jewelerAddress}
🎟️ *Randevu / Talep No:* #${requestId}
🔐 *Güvenlik Doğrulama Kodunuz:* *${securityPin}*

🗺️ *Google Haritalar Yol Tarifi:*
${mapUrl}

⚠️ *ÖNEMLİ GÜVENCE UYARISI:* 
Mağazada ödemenizi alırken yukarıdaki *4 Haneli Güvenlik Kodunu (${securityPin})* mutlaka sarrafa işletiniz. Kodu işletilmeyen işlemler sistemimiz tarafından güvence altına alınamaz.`;

            await sendWhatsAppMessage(customerPhone, customerAppointmentMsg);
        }

        res.json({ 
            success: true, 
            message: `Randevu başarıyla açıldı. Güvenlik PIN kodu müşteriye iletildi.`,
            securityPin: securityPin,
            deal: {
                requestId,
                customerName: customerName || 'Müşteri',
                customerPhone: customerPhone || '',
                jewelerName,
                jewelerAddress,
                agreedPrice: finalPrice
            }
        });
    } catch (err) {
        console.error('Notify winner error:', err);
        res.status(500).json({ success: false, message: 'Randevu bildirimi gönderilemedi.' });
    }
});

// ================= 2. ADIM: MÜŞTERİ MAĞAZAYA GELDİĞİNDE PIN & GERÇEK TUTARLA JETON DÜŞÜMÜ (MÜKERRER KAPATMA KORUMALI) =================
app.post('/api/request/complete-deal', async (req, res) => {
    try {
        const { requestId, jewelerId, actualDealPrice, customerPin } = req.body;
        const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
        const realPrice = Number(actualDealPrice) || 0;

        if (target && target.status === 'COMPLETED') {
            return res.status(400).json({ 
                success: false, 
                message: 'Bu ihale işlemi başka bir cihazdan veya yetkili tarafından zaten kapatılmıştır! Mükerrer işlem yapılamaz.' 
            });
        }

        const alreadyInCompletedList = completedDeals.some(d => String(d.requestId).trim() === String(requestId).trim());
        if (alreadyInCompletedList) {
            return res.status(400).json({ 
                success: false, 
                message: `Bu işlem (#${requestId}) sistemde zaten tamamlanmış görünüyor. Tekrar bakiye kesilmemesi için işlem durduruldu.` 
            });
        }

        if (realPrice <= 0) {
            return res.status(400).json({ success: false, message: 'Lütfen dükkanda gerçekleşen geçerli bir alım tutarı giriniz.' });
        }

        if (target && target.securityPin) {
            const enteredPin = String(customerPin || '').trim();
            if (enteredPin !== String(target.securityPin).trim()) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Girilen 4 haneli Güvenlik PIN kodu hatalı! Lütfen müşterinin telefonundaki kodu kontrol ediniz.' 
                });
            }
        }

        const searchKey = String(jewelerId || target?.winnerCode).trim().toLowerCase();
        const targetJeweler = JEWELERS_DIRECTORY.find(j => 
            (j.id && String(j.id).trim().toLowerCase() === searchKey) || 
            (j.code && String(j.code).trim().toLowerCase() === searchKey) || 
            (j.name && String(j.name).trim().toLowerCase() === searchKey)
        );

        if (!targetJeweler) {
            return res.status(404).json({ success: false, message: 'Kuyumcu hesabı bulunamadı.' });
        }

        const feeCalculation = calculateDealCommissionAndTokens(target?.items, realPrice);
        const calculatedCommissionTL = feeCalculation.commissionTL;
        let deductedTokens = 0;
        let remainingCredits = targetJeweler.credits;

        if (targetJeweler.membershipType === 'token') {
            deductedTokens = feeCalculation.tokens;
            targetJeweler.credits = Math.max(0, (Number(targetJeweler.credits) || 0) - deductedTokens);
            remainingCredits = targetJeweler.credits;
            console.log(`[Dükkanda Tamamlandı]: ${targetJeweler.name} | Gerçekleşen: ${realPrice.toLocaleString('tr-TR')} TL | Oran: ${feeCalculation.appliedRateText} | Düşen: ${deductedTokens} Jeton | Kalan: ${remainingCredits}`);
        }

        if (target) {
            target.status = 'COMPLETED';
            target.actualDealPrice = realPrice;
        }

        const dealRecord = {
            dealId: 'DL_' + Date.now().toString().slice(-6),
            requestId: requestId,
            customerName: target?.customerName || 'Müşteri',
            customerPhone: target?.customerPhone || '',
            jewelerId: targetJeweler.id,
            jewelerName: targetJeweler.name,
            jewelerPhone: targetJeweler.phone,
            jewelerAddress: targetJeweler.address || '',
            originalQuotedPrice: target?.agreedPrice || realPrice,
            agreedPrice: realPrice,
            deductedTokens: deductedTokens,
            remainingCredits: remainingCredits,
            commissionTL: calculatedCommissionTL,
            commissionRateText: feeCalculation.appliedRateText,
            completedAt: new Date().toISOString()
        };

        completedDeals.unshift(dealRecord);
        saveDatabase();

        const tokenNote = (targetJeweler.membershipType === 'token')
            ? `🪙 *Düşen Başarı Jetonu (${feeCalculation.appliedRateText}):* ${deductedTokens} Adet\n🪙 *Kalan Jeton Bakiyeniz:* ${remainingCredits}`
            : `👑 *Üyelik Durumu:* VIP Sınırsız Paket`;

        const finishMsg = 
`✅ *İŞLEM DOĞRULANDI VE KAPATILDI!*

Sayın *${targetJeweler.name}*, #${requestId} nolu alım işlemi güvenlik PIN doğrulamasıyla başarıyla tamamlandı.

💰 *Fiilen Gerçekleşen Tutar:* ${realPrice.toLocaleString('tr-TR')} ₺
📊 *Uygulanan Tarife:* ${feeCalculation.appliedRateText}
${tokenNote}

Hayırlı ve bereketli kazançlar dileriz!`;

        await sendWhatsAppMessage(targetJeweler.phone, finishMsg);

        res.json({
            success: true,
            message: `Güvenlik PIN kodu doğrulandı. İşlem ${realPrice.toLocaleString('tr-TR')} TL üzerinden kapatıldı ve ${deductedTokens} jeton başarı bedeli düşüldü.`,
            deal: dealRecord,
            remainingCredits: remainingCredits,
            deductedTokens: deductedTokens,
            appliedRateText: feeCalculation.appliedRateText
        });
    } catch (err) {
        console.error('Complete deal error:', err);
        res.status(500).json({ success: false, message: 'İşlem tamamlanırken hata oluştu.' });
    }
});

// ================= 3. ADIM: MÜŞTERİ GELMEDİ / İPTAL ROTASI & KAÇAK İŞLEM ÖNLEME MOTORU =================
app.post('/api/request/cancel-deal', async (req, res) => {
    try {
        const { requestId, jewelerId, reason } = req.body;
        const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
        
        if (target) {
            target.status = 'CANCELLED';
            target.cancelReason = reason || 'Müşteri dükkana gelmedi.';
            saveDatabase();
        }

        const searchKey = String(jewelerId || target?.winnerCode).trim().toLowerCase();
        const jeweler = JEWELERS_DIRECTORY.find(j => 
            (j.id && String(j.id).trim().toLowerCase() === searchKey) || 
            (j.code && String(j.code).trim().toLowerCase() === searchKey) || 
            (j.name && String(j.name).trim().toLowerCase() === searchKey)
        );

        const jewelerName = jeweler ? jeweler.name : (jewelerId || 'Anlaşmalı Kuyumcu');

        console.log(`[İhale İptal Bildirimi]: #${requestId} | Sarraf: ${jewelerName} | Sebep: ${reason || 'Müşteri gelmedi'}`);

        if (target && target.customerPhone) {
            const yesLink = `https://altin-eksper.onrender.com/api/request/customer-feedback?req=${requestId}&answer=yes`;
            const noLink = `https://altin-eksper.onrender.com/api/request/customer-feedback?req=${requestId}&answer=no`;

            const auditMessage = 
`❓ *ALTIN EKSPER — İŞLEM DOĞRULAMA TEYİDİ*

Sayın *${target.customerName || 'Müşterimiz'}*, 
*${jewelerName}* ile oluşturulan #${requestId} nolu satış randevunuz için sarraf tarafından *"Müşteri dükkana gelmedi / işlem iptal edildi"* bildirimi yapılmıştır.

Hizmet kalitemizi ve sistem güvencenizi korumak adına lütfen aşağıdaki uygun seçeneğe dokununuz:

👉 *Mağazaya gidip satışı tamamladıysanız tıklayın:*
${yesLink}

👉 *Gerçekten gitmediyseniz / vazgeçtiyseniz tıklayın:*
${noLink}

Geri bildiriminiz için teşekkür ederiz.`;

            await sendWhatsAppMessage(target.customerPhone, auditMessage);
        }

        res.json({
            success: true,
            message: 'İhale iptal kaydı alındı. Müşteriye doğrulama teyidi iletildi.'
        });
    } catch (err) {
        console.error('İptal işlemi hatası:', err);
        res.status(500).json({ success: false, message: 'İptal işlemi başarısız.' });
    }
});

// ================= 4. ADIM: MÜŞTERİ TEYİT LİNKİNE TIKLADIĞINDA ÇALIŞAN GERİ BİLDİRİM ROTASI =================
app.get('/api/request/customer-feedback', async (req, res) => {
    try {
        const { req: requestId, answer } = req.query;
        const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());

        if (answer === 'yes') {
            if (target) {
                target.customerClaimedCompleted = true;
                target.status = 'SUSPECTED_DEAL';
                saveDatabase();
            }

            const alertMsg = 
`🚨 *DİKKAT: ŞÜPHELİ KAÇAK İŞLEM TESPİT EDİLDİ!*

🏷 *Talep No:* #${requestId}
👤 *Müşteri:* ${target ? target.customerName : 'Müşteri'} (${target ? target.customerPhone : ''})
🏪 *Sarraf:* ${target ? target.winnerCode : 'Kuyumcu'}
💰 *Ön Fiyat:* ${target ? Number(target.agreedPrice).toLocaleString('tr-TR') : 0} ₺

⚠️ *Durum:* Sarraf panelden "Müşteri Gelmedi" diyerek işlemi iptal etti; ancak müşteri az önce linke tıklayarak mağazada satışı tamamladığını BEYAN ETTİ!`;

            await sendWhatsAppMessage(WHATSAPP_CONFIG.adminPhone, alertMsg);

            res.send(`
                <!DOCTYPE html>
                <html lang="tr">
                <head><meta charset="UTF-8"><title>Geri Bildirim Alındı</title>
                <style>body{font-family:sans-serif; text-align:center; padding:40px 20px; background:#0f172a; color:#fff;}</style></head>
                <body>
                    <h2 style="color:#10b981;">✓ Bildiriminiz Alındı</h2>
                    <p style="color:#cbd5e1; max-width:480px; margin:0 auto; line-height:1.6;">
                        İşleminizi mağazada gerçekleştirdiğinizi belirttiniz. Bilgi sistemimize kaydedilmiştir. İlginiz için teşekkür ederiz.
                    </p>
                </body>
                </html>
            `);
        } else {
            res.send(`
                <!DOCTYPE html>
                <html lang="tr">
                <head><meta charset="UTF-8"><title>Geri Bildirim Alındı</title>
                <style>body{font-family:sans-serif; text-align:center; padding:40px 20px; background:#0f172a; color:#fff;}</style></head>
                <body>
                    <h2 style="color:#38bdf8;">✓ Teşekkür Ederiz</h2>
                    <p style="color:#cbd5e1; max-width:480px; margin:0 auto; line-height:1.6;">
                        Randevuya gidemediğinizi belirttiniz. İşlem kaydınız güvenle kapatılmıştır.
                    </p>
                </body>
                </html>
            `);
        }
    } catch (e) {
        res.status(500).send('İşlem kaydedilemedi.');
    }
});

// ================= KOMİSYON & MUHASEBE RAPORU =================
app.get('/api/admin/commission-report', adminAuthMiddleware, (req, res) => {
    let totalTurnover = 0;
    let totalCommission = 0;
    let totalTokensUsed = 0;

    completedDeals.forEach(d => {
        totalTurnover += (d.agreedPrice || 0);
        totalCommission += (d.commissionTL || 0);
        totalTokensUsed += (d.deductedTokens || 0);
    });

    res.json({
        success: true,
        stats: {
            totalDeals: completedDeals.length,
            totalTurnover,
            totalCommission,
            totalTokensUsed,
            estimatedPlatformRevenue: totalTokensUsed * TOKEN_UNIT_VALUE_TL
        },
        deals: completedDeals,
        jewelers: JEWELERS_DIRECTORY
    });
});
// ================= CANLI ALTIN KURU DAĞITIMI =================
let cachedHasGram = 6725;

// ================= CANLI ALTIN KURU MOTORU & ROTASI =================
let cachedHasGram = 6483.93;

async function updateLiveGold() {
    try {
        const [resUsd, resGold] = await Promise.all([
            fetch('https://open.er-api.com/v6/latest/USD'),
            fetch('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT')
        ]);

        if (resUsd.ok && resGold.ok) {
            const dataUsd = await resUsd.json();
            const dataGold = await resGold.json();

            const usdTry = dataUsd?.rates?.TRY;
            const ounceUsd = parseFloat(dataGold.price);

            if (ounceUsd > 1000 && usdTry > 10) {
                cachedHasGram = Math.round(((ounceUsd / 31.1034768) * usdTry * 0.995) * 100) / 100;
                console.log('[Canlı Kur]: Has Gram:', cachedHasGram, 'TL');
            }
        }
    } catch (e) {
        console.error('[Canlı Kur Hatası]:', e.message);
    }
}

updateLiveGold();
setInterval(updateLiveGold, 30000);

app.get('/api/live-prices', (req, res) => {
    res.json({ success: true, hasGram: cachedHasGram });
});
app.listen(PORT, () => {
    console.log(`Altın Eksper API Sunucusu ${PORT} portunda çalışıyor.`);
});