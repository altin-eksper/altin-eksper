const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Statik frontend dosyalarını (index.html, cities.js vb.) sun
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// ================= META WHATSAPP CLOUD API AYARLARI =================
const WHATSAPP_CONFIG = {
    phoneNumberId: '1293164497207661',
    accessToken: 'EAAY3ClF5SXgBSvgXSHZAurDYzkpdsc3AmrsBk8oVTBSrpsM3CeZAAv04uLO3YCHzJBkPNa0WPnGiKeL0253BeARRDELXxJ9jk3YmnZBUa9NGJ4GIbzqJEZAd2LuhBajfmj9F3EghXtZBsePrGBDQ7qkpo06ZAhx2odj4GIqPdyNWLhSaEC0OoWjnRxrIpKiWjBYbmWvgBqIdHS5CAuZBtoO41FyTzBWuX1wiezMQpdk5so5bXpZCYDibnCoicrTFOxu6zG4rIdueNZC7gC6wGgCwON9TkRQZDZD',
    apiVersion: 'v21.0'
};

// WhatsApp Mesaj Gönderme Yardımcı Fonksiyonu
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
        console.log(`[WhatsApp API Sonucu -> ${cleanPhone}]:`, data);
        return data;
    } catch (err) {
        console.error('[WhatsApp Gönderim Hatası]:', err);
        return null;
    }
}

// Canlı Talep Havuzu
let requestsPool = [];

// Süresi dolan (15 dk) talepleri otomatik temizleme
setInterval(() => {
    const now = Date.now();
    requestsPool = requestsPool.filter(r => !r.expiresAt || new Date(r.expiresAt).getTime() > now);
}, 30000);

// Ana Sayfa Yönlendirmesi
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Yeni Müşteri Satış Talebi Oluşturma & WhatsApp Bildirimi
app.post('/api/request/create', async (req, res) => {
    try {
        const reqData = req.body;
        if (!reqData || !reqData.requestId) {
            return res.status(400).json({ success: false, message: 'Geçersiz talep verisi' });
        }

        reqData.quotes = [];
        requestsPool.unshift(reqData);

        const itemsList = (reqData.items || []).map(it => 
            `• ${it.productName} (${it.karat}k) - ${it.grams ? it.grams + 'g' : ''} ${it.qty ? it.qty + ' adet' : ''}`
        ).join('\n');

        const messageBody = 
`🔔 *ALTIN EKSPER — YENİ NAKİT ALIŞ İHALESİ*

🏷 *Talep No:* #${reqData.requestId}
👤 *Müşteri:* ${reqData.customerName || 'Müşteri'}
📍 *Bölge:* ${reqData.district || 'Merkez'}
⚖️ *Toplam Ağırlık:* ${reqData.totalGrams || '0 g'}
💰 *Gösterge Değeri:* ${reqData.totalReferenceTL || '0 ₺'}

📦 *Satılacak Ürünler:*
${itemsList}

⏱ *Kalan Teklif Süresi:* 15 Dakika
👉 İhaleyi incelemek ve teklif vermek için panele giriş yapınız.`;

        if (reqData.customerPhone) {
            await sendWhatsAppMessage(reqData.customerPhone, messageBody);
        }

        res.json({ success: true, message: 'Talep havuza alındı ve WhatsApp bildirimi iletildi.', requestId: reqData.requestId });
    } catch (error) {
        console.error('Create error:', error);
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// 2. Aktif Talepleri Listeleme
app.get('/api/requests', (req, res) => {
    const now = Date.now();
    const active = requestsPool.filter(r => !r.expiresAt || new Date(r.expiresAt).getTime() > now);
    res.json({ success: true, requests: active });
});

// 3. Tek Bir Talebi Getirme
app.get('/api/request/:id', (req, res) => {
    const found = requestsPool.find(r => String(r.requestId) === String(req.params.id));
    if (!found) return res.status(404).json({ success: false, message: 'Talep bulunamadı' });
    res.json({ success: true, data: found });
});

// 4. Sarraf Teklifi Ekleme
app.post('/api/request/quote', (req, res) => {
    const { requestId, jewelerCode, offerPrice, note } = req.body;
    const target = requestsPool.find(r => String(r.requestId) === String(requestId));
    if (!target) return res.status(404).json({ success: false, message: 'Talep bulunamadı' });

    target.quotes = target.quotes || [];
    const idx = target.quotes.findIndex(q => q.jewelerCode === jewelerCode);
    if (idx !== -1) {
        target.quotes[idx] = { jewelerCode, offerPrice, note };
    } else {
        target.quotes.push({ jewelerCode, offerPrice, note });
    }

    res.json({ success: true, quotes: target.quotes });
});

// 5. Kazanan Sarraf Bildirimi
app.post('/api/request/notify-winner', async (req, res) => {
    const { requestId, winnerCode, agreedPrice, customerName, jewelerPhone } = req.body;

    if (jewelerPhone) {
        const winnerMessage = 
`🎉 *TEBRİKLER! İHALE SİZDE KALDI*

🏷 *Talep No:* #${requestId}
👤 *Müşteri:* ${customerName}
💰 *Kabul Edilen Teklif:* ${agreedPrice} ₺

Müşteriye randevu kodu iletildi. Kontroller sonrası işlemi tamamlayabilirsiniz.`;

        await sendWhatsAppMessage(jewelerPhone, winnerMessage);
    }

    res.json({ success: true, message: 'Kazanan sarrafa bildirim gönderildi.' });
});

app.listen(PORT, () => {
    console.log(`Altın Eksper API Sunucusu ${PORT} portunda çalışıyor.`);
});