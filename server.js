const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DB_FILE = path.join(__dirname, 'database.json');

// Kuyumcular ve Özel PIN Kodları
const DEFAULT_JEWELERS = [
    { code: 'K001', pin: '1453', name: 'Yıldız Sarrafiye', district: 'Muratpaşa', phone: '905320000001', address: 'Işıklar Cad. No:14 Muratpaşa / Antalya', active: true },
    { code: 'K002', pin: '2026', name: 'Akdeniz Kuyumculuk', district: 'Kepez', phone: '905320000002', address: 'Dokuma Çallı Meydanı No:5 Kepez / Antalya', active: true },
    { code: 'K003', pin: '0707', name: 'Toros Altın', district: 'Konyaaltı', phone: '905320000003', address: 'Atatürk Bulvarı No:88 Konyaaltı / Antalya', active: true },
    { code: 'K004', pin: '1923', name: 'Alanya Sarraf', district: 'Alanya', phone: '905320000004', address: 'Hükümet Cad. No:22 Alanya / Antalya', active: true },
    { code: 'K005', pin: '1234', name: 'Manavgat Mücevherat', district: 'Manavgat', phone: '905320000005', address: 'Antalya Cad. No:45 Manavgat / Antalya', active: true }
];

function readDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = { requests: {}, jewelers: DEFAULT_JEWELERS };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
            return initialData;
        }
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.jewelers || !parsed.jewelers.length) parsed.jewelers = DEFAULT_JEWELERS;
        return parsed;
    } catch (e) {
        console.error('Veritabanı okuma hatası:', e.message);
        return { requests: {}, jewelers: DEFAULT_JEWELERS };
    }
}

function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('Veritabanı kaydetme hatası:', e.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', time: new Date().toISOString() });
});

/* KUYUMCU ŞİFRE / PIN DOĞRULAMA ROTASI */
app.post('/api/jeweler/auth', (req, res) => {
    const { code, pin } = req.body;
    const db = readDatabase();
    const jeweler = (db.jewelers || []).find(j => 
        (j.code.toUpperCase() === (code || '').toUpperCase().trim() || 
         j.name.toLowerCase().includes((code || '').toLowerCase().trim())) && 
        j.active
    );

    if (!jeweler) {
        return res.status(404).json({ success: false, message: 'Kayıtlı sarraf bulunamadı.' });
    }

    if (jeweler.pin !== String(pin).trim()) {
        return res.status(401).json({ success: false, message: 'Hatalı sarraf PIN kodu!' });
    }

    res.json({
        success: true,
        jeweler: {
            code: jeweler.code,
            name: jeweler.name,
            district: jeweler.district,
            address: jeweler.address,
            phone: jeweler.phone
        }
    });
});

/* TALEP OLUŞTURMA */
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
        console.log(`✅ [HAVUZA DÜŞTÜ]: #${requestId} - ${customerName}`);
        res.json({ success: true, requestId, expiresAt });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* TÜM TALEPLER */
app.get('/api/requests', (req, res) => {
    try {
        const db = readDatabase();
        const list = Object.values(db.requests || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ success: true, requests: list });
    } catch (err) {
        res.status(500).json({ success: false, requests: [] });
    }
});

/* TEK TALEP DETAYI */
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

/* KUYUMCU TEKLİFİNİ DOĞRULAYIP ALMA */
app.post('/api/request/quote', (req, res) => {
    try {
        const { requestId, jewelerCode, pin, offerPrice, note } = req.body;
        const db = readDatabase();
        const requestSession = db.requests[requestId];

        if (!requestSession) {
            return res.status(404).json({ success: false, message: 'Talep bulunamadı veya süresi doldu.' });
        }

        // Şifre kontrolü
        const jeweler = (db.jewelers || []).find(j => j.code.toUpperCase() === (jewelerCode || '').toUpperCase().trim());
        if (jeweler && pin && jeweler.pin !== String(pin).trim()) {
            return res.status(401).json({ success: false, message: 'Geçersiz kuyumcu şifresi!' });
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
        console.log(`💰 [TEKLİF İŞLENDİ]: #${requestId} - ${jewelerCode} (${priceNum} TL)`);

        res.json({ success: true, bestQuote: requestSession.quotes[0], quotes: requestSession.quotes });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* KAZANAN SARRAFA BİLDİRİM */
app.post('/api/request/notify-winner', (req, res) => {
    const { requestId, winnerCode, agreedPrice, customerName } = req.body;
    console.log(`🏁 [KAZANAN SARRAF]: #${requestId} -> ${winnerCode} (${agreedPrice} TL)`);
    res.json({ success: true, message: 'Bildirim işlendi.' });
});

app.listen(PORT, () => {
    console.log(`🚀 ALTIN EKSPER SUNUCUSU AKTİF (Port: ${PORT})`);
});
