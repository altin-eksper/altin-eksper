const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================= META WHATSAPP CLOUD API AYARLARI =================
const WHATSAPP_CONFIG = {
    phoneNumberId: '1293164497207661',
    accessToken: 'EAAY3ClF5SXgBSgKOGZAf4f2hIzEYFjjbLMmOpQ790tWqSYKnFCrCpKUgp8It3BAAPZCXhIGpIXWHlz0MhOd2ZCeE7tWxyOlUc9rGH0QbOyFpnvNZCIZAbtpVOa4NOZBg9DKrWUOd6MfqXPttArAyeAkzUc6dN9GyfmWWSR0eBoJnt95qMdR65QDRtHZC4hOWzi47QZDZD',
    apiVersion: 'v21.0'
};

// ================= KAYITLI SARRAFLAR / KUYUMCULAR REHBERİ =================
// Canlıya geçtiğinizde buraya dilediğiniz kadar gerçek sarraf ekleyebilirsiniz.
const JEWELERS_DIRECTORY = [
    {
        id: 'SARRAF_01',
        name: 'Güneş Sarrafiye',
        city: 'Antalya',
        district: 'Muratpaşa',
        phone: '905399321893' // Test için numaranız tanımlandı
    },
    {
        id: 'SARRAF_02',
        name: 'Karat Mücevherat',
        city: 'Antalya',
        district: 'Kepez',
        phone: '905399321893'
    },
    {
        id: 'SARRAF_03',
        name: 'Akdeniz Kuyumculuk',
        city: 'Antalya',
        district: 'Muratpaşa',
        phone: '905399321893'
    }
];

// WhatsApp Mesaj Gönderme Motoru
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

// Canlı Talep Deposu (Hafıza Havuzu)
let requestsPool = [];

// Süresi dolan (15 dk) talepleri otomatik temizleme
setInterval(() => {
    const now = Date.now();
    requestsPool = requestsPool.filter(r => !r.expiresAt || new Date(r.expiresAt).getTime() > now);
}, 30000);

// Ana Sayfa Rotaları
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Yeni Satış İhalesi Başlatma & İlgili Sarraflara Toplu Dağıtım
app.post('/api/request/create', async (req, res) => {
    try {
        const reqData = req.body;
        if (!reqData || !reqData.requestId) {
            return res.status(400).json({ success: false, message: 'Geçersiz talep verisi' });
        }

        reqData.quotes = [];
        requestsPool.unshift(reqData);

        const targetCity = (reqData.city || 'Antalya').trim();
        const targetDistrict = (reqData.district || '').trim();

        // Bölgedeki sarrafları filtrele (İlçe eşleşmesi, yoksa il geneli)
        let matchedJewelers = JEWELERS_DIRECTORY.filter(j => 
            j.city.toLowerCase() === targetCity.toLowerCase() &&
            j.district.toLowerCase() === targetDistrict.toLowerCase()
        );

        if (matchedJewelers.length === 0) {
            matchedJewelers = JEWELERS_DIRECTORY.filter(j => 
                j.city.toLowerCase() === targetCity.toLowerCase()
            );
        }

        // Satılacak altınların listesi
        const itemsList = (reqData.items || []).map(it => 
            `• ${it.productName} (${it.karat}k) - ${it.grams ? it.grams + 'g' : ''} ${it.qty ? it.qty + ' adet' : ''}`
        ).join('\n');

        // Eşleşen sarraflara WhatsApp bildirimi fırlat
        console.log(`[Dağıtım]: ${targetDistrict} bölgesinde ${matchedJewelers.length} sarrafa ihale iletiliyor...`);
        for (const jeweler of matchedJewelers) {
            // Her sarrafa kendi ID'sini içeren özel teklif verme linki üretilir
            const offerLink = `https://altin-eksper.onrender.com/kuyumcu.html?req=${reqData.requestId}&jeweler=${jeweler.id}`;

            const jewelerNotification = 
`🔔 *ALTIN EKSPER — BÖLGENİZDE YENİ İHALE!*

Sayın Sarraf İş Ortağımız, bölgenizde nakit altın satmak isteyen yeni bir müşteri ihalesi başladı.

🏷 *Talep No:* #${reqData.requestId}
📍 *Konum:* ${targetCity} / ${targetDistrict}
⚖️ *Toplam Ağırlık:* ${reqData.totalGrams || '0 g'}
💰 *Referans Değer:* ${reqData.totalReferenceTL || '0 ₺'}

📦 *Müşterinin Altınları:*
${itemsList}

⏱ *Kalan Teklif Süresi:* 15 Dakika
👉 *Hemen Teklif Verin:* ${offerLink}`;

            await sendWhatsAppMessage(jeweler.phone, jewelerNotification);
        }
        // Müşteriye bilgi teyidi (Varsa)
        if (reqData.customerPhone) {
            const customerMsg = `✅ *Altın Eksper:* #${reqData.requestId} nolu satış talebiniz ${targetDistrict} bölgesindeki kayıtlı sarraflara iletildi. Teklifler toplanıyor, 15 dakika içinde en iyi teklif size bildirilecektir.`;
            await sendWhatsAppMessage(reqData.customerPhone, customerMsg);
        }

        res.json({ 
            success: true, 
            message: `İhale açıldı, bölgedeki ${matchedJewelers.length} sarrafa WhatsApp iletildi.`, 
            requestId: reqData.requestId 
        });
    } catch (error) {
        console.error('Create error:', error);
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// 2. Aktif Talepleri Listeleme (Kuyumcu Paneli İçin)
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

// 4. Sarraf Teklifi Ekleme / Güncelleme
app.post('/api/request/quote', (req, res) => {
    const { requestId, jewelerCode, offerPrice, note } = req.body;
    console.log(`[Teklif Girişi]: #${requestId} için ${jewelerCode} -> ${offerPrice} TL`);

    const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
    if (!target) {
        console.error(`[Teklif Hatası]: #${requestId} nolu talep bulunamadı! Mevcutlar:`, requestsPool.map(r => r.requestId));
        return res.status(404).json({ success: false, message: 'Talep bulunamadı' });
    }

    target.quotes = target.quotes || [];
    const idx = target.quotes.findIndex(q => q.jewelerCode === jewelerCode);
    if (idx !== -1) {
        target.quotes[idx] = { jewelerCode, offerPrice: Number(offerPrice), note };
    } else {
        target.quotes.push({ jewelerCode, offerPrice: Number(offerPrice), note });
    }

    console.log(`[Güncel Teklifler #${requestId}]:`, target.quotes);
    res.json({ success: true, quotes: target.quotes });
});

// 5. Kazanan Sarraf & Randevu Bildirimi
app.post('/api/request/notify-winner', async (req, res) => {
    try {
        const { requestId, jewelerCode, agreedPrice, customerName, customerPhone } = req.body;

        // Sarraf rehberinden sarrafın telefonunu bul (yoksa test numaranıza fırlatır)
        const targetJeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerCode || j.name === jewelerCode);
        const jewelerPhone = targetJeweler ? targetJeweler.phone : '905399321893';

        const winnerMessage = 
`🎉 *TEBRİKLER! İHALE SİZDE KALDI*

Sayın İş Ortağımız, verdiğiniz teklif müşteri tarafından onaylandı!

🏷 *İhale No:* #${requestId}
👤 *Müşteri Adı:* ${customerName || 'Müşteri'}
💰 *Anlaşılan Tutar:* ${Number(agreedPrice).toLocaleString('tr-TR')} ₺

📌 *Müşteri İletişim:* ${customerPhone || 'Girilmedi'}
Müşteriye mağazanız için randevu kodu tanımlandı. Müşteri kısa süre içinde dükkanınıza gelecektir.`;

        await sendWhatsAppMessage(jewelerPhone, winnerMessage);

        res.json({ success: true, message: 'Kazanan sarrafa WhatsApp randevu bildirimi başarıyla iletildi.' });
    } catch (err) {
        console.error('Notify winner error:', err);
        res.status(500).json({ success: false, message: 'Bildirim gönderilemedi.' });
    }
});

app.listen(PORT, () => {
    console.log(`Altın Eksper API Sunucusu ${PORT} portunda çalışıyor.`);
});