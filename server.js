const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Tüm kaynaklara izin ver
app.use(cors());
app.use(express.json());

// Statik dosyaları doğrudan sun
app.use(express.static(path.join(__dirname)));

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

// Ana Sayfa Yönlendirmesi (Render İçin Zorunlu)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Canlılık / Sağlık Kontrolü
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', time: new Date().toISOString() });
});

/* 1. TALEP OLUŞTURMA & OTOMATİK İHALE FIRLATMA */
app.post('/api/request/create', (req, res) => {
    try {
        const { requestId, customerName, customerPhone, district, totalGrams, totalReferenceTL, items } = req.body;

        if (!requestId || !items || !items.length) {
            return res.status(400).json({ success: false, message: 'Geçersiz talep verisi.' });
        }

        const db = readDatabase();
        const durationMinutes = 15;
        const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

        const newRequest = {
            requestId: String(requestId),
            customerName: customerName || 'İsimsiz Müşteri',
            customerPhone: customerPhone || 'Belirtilmedi',
            district: district || 'Merkez',
            totalGrams: totalGrams || '0,00 g',
            totalReferenceTL: totalReferenceTL || '₺0,00',
            items: items,
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
            expiresAt: expiresAt.toISOString(),
            quotes: []
        };

        db.requests[requestId] = newRequest;
        writeDatabase(db);

        console.log(`✅ [HAVUZA YAZILDI]: #${requestId} - ${customerName} (${totalGrams})`);

        res.json({ success: true, requestId, expiresAt });
    } catch (err) {
        console.error('Kayıt Hatası:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/* 2. TÜM TALEPLERİ LİSTELEME (HAVUZ İÇİN) */
app.get('/api/requests', (req, res) => {
    try {
        const db = readDatabase();
        const list = Object.values(db.requests || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ success: true, requests: list });
    } catch (err) {
        res.status(500).json({ success: false, requests: [] });
    }
});

/* 3. TEK TALEP DETAYI */
app.get('/api/request/:id', (req, res) => {
    try {
        const db = readDatabase();
        const item = db.requests[req.params.id];
        if (!item) return res.status(404).json({ success: false, message: 'Talep bulunamadı.' });
        res.json({ success: true, data: item });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* 4. KUYUMCU TEKLİFİNİ ALMA */
app.post('/api/request/quote', (req, res) => {
    try {
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
        writeDatabase(db);

        console.log(`💰 [TEKLİF GELDİ]: #${requestId} - ${jewelerCode} -> ${priceNum} TL`);

        res.json({ success: true, bestQuote: requestSession.quotes[0], quotes: requestSession.quotes });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* 5. KAZANAN KUYUMCUYA RANDEVU BİLDİRİMİ */
app.post('/api/request/notify-winner', (req, res) => {
    const { requestId, winnerCode, agreedPrice, customerName } = req.body;
    console.log(`🏁 [KAZANAN SARRAF]: #${requestId} -> ${winnerCode} (${agreedPrice} TL)`);
    res.json({ success: true, message: 'Bildirim işlendi.' });
});

app.listen(PORT, () => {
    console.log(`🚀 ALTIN EKSPER SUNUCUSU AKTİF (Port: ${PORT})`);
});