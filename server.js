const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
// Canlı bulut sunucuları (Render, Railway vb.) için dinamik port:
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const DB_FILE = path.join(__dirname, 'database.json');

const DEFAULT_JEWELERS = [
    { code: 'K001', name: 'Yıldız Sarrafiye', district: 'Muratpaşa', phone: '905320000001', address: 'Işıklar Cad. No:14 Muratpaşa / Antalya', active: true },
    { code: 'K002', name: 'Akdeniz Kuyumculuk', district: 'Kepez', phone: '905320000002', address: 'Dokuma Çallı Meydanı No:5 Kepez / Antalya', active: true },
    { code: 'K003', name: 'Toros Altın', district: 'Konyaaltı', phone: '905320000003', address: 'Atatürk Bulvarı No:88 Konyaaltı / Antalya', active: true },
    { code: 'K004', name: 'Alanya Sarraf', district: 'Alanya', phone: '905320000004', address: 'Hükümet Cad. No:22 Alanya / Antalya', active: true },
    { code: 'K005', name: 'Manavgat Mücevherat', district: 'Manavgat', phone: '905320000005', address: 'Antalya Cad. No:45 Manavgat / Antalya', active: true }
];

function readDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = { requests: {}, jewelers: DEFAULT_JEWELERS };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
            return initialData;
        }
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('❌ Veritabanı okuma hatası:', e.message);
        return { requests: {}, jewelers: DEFAULT_JEWELERS };
    }
}

function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('❌ Veritabanı kaydetme hatası:', e.message);
    }
}

const WA_CONFIG = {
    ACCESS_TOKEN: process.env.META_WA_TOKEN || 'BURAYA_ACCESS_TOKEN_GELECEK',
    PHONE_NUMBER_ID: process.env.META_PHONE_ID || 'BURAYA_PHONE_NUMBER_ID_GELECEK',
    API_URL: 'https://graph.facebook.com/v18.0'
};

async function sendWhatsAppCloudMessage(targetPhone, messageText) {
    if (WA_CONFIG.ACCESS_TOKEN === 'BURAYA_ACCESS_TOKEN_GELECEK') {
        console.log(`📡 [SİMÜLASYON WHATSAPP] -> ${targetPhone} numarasına bildirim gönderildi.`);
        return { success: true, simulated: true };
    }

    try {
        const response = await fetch(`${WA_CONFIG.API_URL}/${WA_CONFIG.PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WA_CONFIG.ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: targetPhone,
                type: 'text',
                text: { body: messageText }
            })
        });
        const data = await response.json();
        return { success: response.ok, data };
    } catch (error) {
        console.error(`❌ WhatsApp Gönderim Hatası (${targetPhone}):`, error.message);
        return { success: false, error: error.message };
    }
}

/* 1. TALEP OLUŞTURMA & OTOMATİK İHALE FIRLATMA */
app.post('/api/request/create', async (req, res) => {
    const { requestId, customerName, customerPhone, district, totalGrams, totalReferenceTL, items } = req.body;

    if (!items || !items.length) {
        return res.status(400).json({ success: false, message: 'Ürün listesi boş olamaz.' });
    }

    const db = readDatabase();
    const durationMinutes = 15;
    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

    const newRequest = {
        requestId,
        customerName: customerName || 'İsimsiz Müşteri',
        customerPhone: customerPhone || 'Belirtilmedi',
        district: district || 'Merkez',
        totalGrams,
        totalReferenceTL,
        items,
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        quotes: []
    };

    db.requests[requestId] = newRequest;
    writeDatabase(db);

    console.log(`\n==================================================`);
    console.log(`💾 [VERİTABANINA YAZILDI] Talep No: #${requestId}`);
    console.log(`📍 Hedef İlçe(ler): ${district} | Ağırlık: ${totalGrams}`);
    console.log(`==================================================`);

    const selectedDistricts = (district || '').split(',').map(d => d.trim().toLowerCase());
    const matchedJewelers = (db.jewelers || []).filter(j => 
        j.active && selectedDistricts.some(sd => j.district.toLowerCase().includes(sd))
    );

    console.log(`🎯 Hedef Kuyumcu Sayısı: ${matchedJewelers.length} sarraf`);

    let productSummary = items.map((it, idx) => `${idx + 1}. ${it.productName} (${it.karat}k) - ${it.grams || it.qty || ''}`).join('\n');
    
    // Canlıda hangi adresteyse oraya dinamik link üretir
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const portalUrl = `${protocol}://${host}/kuyumcu.html?id=${requestId}`;

    const broadcastMessage = `🚨 *ALTIN EKSPER — YENİ NAKİT ALIŞ İHALESİ*\n\n` +
        `🏷 *İhale No:* #${requestId}\n` +
        `📍 *Bölge:* ${district}\n` +
        `⚖️ *Toplam Ağırlık:* ${totalGrams}\n\n` +
        `📦 *Ürünler:*\n${productSummary}\n\n` +
        `⏱ *Süre:* 15 Dakika\n\n` +
        `👉 *Teklif vermek için tıklayın:*\n${portalUrl}`;

    matchedJewelers.forEach(jeweler => {
        sendWhatsAppCloudMessage(jeweler.phone, broadcastMessage);
    });

    res.json({ success: true, requestId, expiresAt, dispatchedCount: matchedJewelers.length });
});

/* 2. TÜM TALEPLERİ LİSTELEME */
app.get('/api/requests', (req, res) => {
    const db = readDatabase();
    const list = Object.values(db.requests || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: list });
});

/* 3. TEK TALEP DETAYI */
app.get('/api/request/:id', (req, res) => {
    const db = readDatabase();
    const item = db.requests[req.params.id];
    if (!item) return res.status(404).json({ success: false, message: 'Talep bulunamadı.' });
    res.json({ success: true, data: item });
});

/* 4. KUYUMCU TEKLİFİNİ ALMA */
app.post('/api/request/quote', (req, res) => {
    const { requestId, jewelerCode, offerPrice, note } = req.body;
    const db = readDatabase();
    const requestSession = db.requests[requestId];

    if (!requestSession) {
        return res.status(404).json({ success: false, message: 'Talep bulunamadı veya süresi doldu.' });
    }

    const priceNum = parseFloat(offerPrice) || 0;
    if (priceNum <= 0) {
        return res.status(400).json({ success: false, message: 'Geçersiz teklif tutarı.' });
    }

    requestSession.quotes = requestSession.quotes || [];
    const existingIndex = requestSession.quotes.findIndex(q => q.jewelerCode === jewelerCode);
    const quoteData = {
        jewelerCode: jewelerCode || 'K000',
        offerPrice: priceNum,
        note: note || '',
        updatedAt: new Date().toISOString()
    };

    if (existingIndex !== -1) {
        requestSession.quotes[existingIndex] = quoteData;
    } else {
        requestSession.quotes.push(quoteData);
    }

    requestSession.quotes.sort((a, b) => b.offerPrice - a.offerPrice);
    const bestQuote = requestSession.quotes[0];

    writeDatabase(db);

    console.log(`\n💰 [TEKLİF DISKE İŞLENDİ]: [#${requestId}] ${jewelerCode} -> ${priceNum.toLocaleString('tr-TR')} TL`);
    console.log(`🥇 EN İYİ TEKLİF: ${bestQuote.offerPrice.toLocaleString('tr-TR')} TL (${bestQuote.jewelerCode})\n`);

    res.json({ success: true, message: 'Teklif kalıcı olarak işlendi.', bestQuote, quotes: requestSession.quotes });
});

/* 5. KAZANAN KUYUMCUYA RANDEVU BİLDİRİMİ */
app.post('/api/request/notify-winner', (req, res) => {
    const { requestId, winnerCode, agreedPrice, customerName } = req.body;
    const db = readDatabase();
    const requestSession = db.requests[requestId];

    if (!requestSession) {
        return res.status(404).json({ success: false, message: 'Talep bulunamadı.' });
    }

    const jeweler = (db.jewelers || []).find(j => j.code === winnerCode || j.name.includes(winnerCode));
    const targetPhone = jeweler ? jeweler.phone : '905320000001';

    const winMsg = `🎉 *ALTIN EKSPER — İHALE KAZANILDI & RANDEVU OLUŞTURULDU*\n\n` +
        `🏷 *İhale Randevu Kodu:* #${requestId}\n` +
        `👤 *Müşteri:* ${customerName || 'Müşteri'}\n` +
        `💰 *Taahhüt Edilen Alış Tutarı:* ${parseFloat(agreedPrice).toLocaleString('tr-TR')} TL\n` +
        `⚖️ *Toplam Gramaj:* ${requestSession.totalGrams}\n\n` +
        `📌 *Bilgilendirme:* Müşterimiz mağazanıza yönlendirilmiştir. Fiziki tartı ve ayar kontrolü sonrası ödeme gerçekleştirilecektir.`;

    sendWhatsAppCloudMessage(targetPhone, winMsg);
    console.log(`🏁 [KAZANAN BİLDİRİLDİ]: #${requestId} ihaleyi kazandı -> ${winnerCode} (${agreedPrice} TL)`);

    res.json({ success: true, message: 'Kazanan sarrafa bildirim gönderildi.' });
});

app.listen(PORT, () => {
    console.log(`🚀 ALTIN EKSPER SUNUCUSU AKTİF (Port: ${PORT})`);
    console.log(`📁 Veritabanı: ${DB_FILE}`);
});