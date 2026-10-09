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
    apiVersion: 'v21.0',
    adminPhone: '905399321893' // Sistem yöneticisi WhatsApp bildirim hattı
};

// ================= ONAYLI & BAKİYELİ KUYUMCULAR LİSTESİ =================
// Başvuru yapan ve ödemesini tamamlayarak onayladığınız esnaflar burada tutulur.
let JEWELERS_DIRECTORY = [
    {
        id: 'SARRAF_01',
        name: 'Güneş Sarrafiye',
        city: 'Antalya',
        districts: ['Muratpaşa'],
        phone: '905399321893', // Test numaranız
        membershipType: 'token', // 'token' (jeton) veya 'subscription' (aylık paket)
        credits: 25,             // Kalan teklif hakkı
        subscriptionExpiresAt: null,
        status: 'ACTIVE'         // 'ACTIVE', 'PENDING', 'SUSPENDED'
    },
    {
        id: 'SARRAF_02',
        name: 'Karat Mücevherat',
        city: 'Antalya',
        districts: ['Kepez'],
        phone: '905399321893',
        membershipType: 'subscription',
        credits: 0,
        subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 gün aktif
        status: 'ACTIVE'
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

// Ana Sayfa Rotası
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ================= KUYUMCU ÜYELİK & BAKİYE YÖNETİMİ =================

// Kuyumcu Yeni Başvuru Endpoint'i (Siteden form doldurduğunda çalışır)
app.post('/api/jeweler/apply', async (req, res) => {
    try {
        const { firmName, phone, city, district, planType } = req.body;
        if (!firmName || !phone) {
            return res.status(400).json({ success: false, message: 'Firma adı ve telefon zorunludur.' });
        }

        const newId = 'SARRAF_' + String(Date.now()).slice(-4);
        const newJeweler = {
            id: newId,
            name: firmName,
            city: city || 'Antalya',
            districts: district ? [district] : ['Muratpaşa'],
            phone: phone,
            membershipType: planType === 'subscription' ? 'subscription' : 'token',
            credits: 0, // Ödeme alınana kadar 0 hak
            subscriptionExpiresAt: null,
            status: 'PENDING' // Siz onaylayana kadar beklemede
        };

        JEWELERS_DIRECTORY.push(newJeweler);

        // Yöneticiye (Size) WhatsApp'tan haber ver
        const adminAlert = 
`💼 *YENİ KUYUMCU BAŞVURUSU!*

🏢 *Firma:* ${firmName}
📞 *Telefon:* ${phone}
📍 *Bölge:* ${city || 'Antalya'} / ${district || 'Belirtilmedi'}
📦 *Tercih Edilen Paket:* ${planType === 'subscription' ? 'Aylık Sınırsız' : 'Jeton / Hak Paketi'}
🆔 *Kuyumcu Kodu:* ${newId}

Ödeme teyidinden sonra admin panelinden hesabı aktif edebilirsiniz.`;

        await sendWhatsAppMessage(WHATSAPP_CONFIG.adminPhone, adminAlert);

        res.json({ 
            success: true, 
            message: 'Başvurunuz alındı. Yetkilimiz en kısa sürede sizinle iletişime geçecektir.',
            jewelerId: newId 
        });
    } catch (err) {
        console.error('Kuyumcu başvuru hatası:', err);
        res.status(500).json({ success: false, message: 'Başvuru alınamadı.' });
    }
});

// Yönetici: Kuyumcu Onaylama & Paket/Jeton Yükleme Endpoint'i
app.post('/api/admin/jeweler/topup', (req, res) => {
    const { jewelerId, addCredits, extendDays, activate } = req.body;
    const jeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerId);

    if (!jeweler) {
        return res.status(404).json({ success: false, message: 'Kuyumcu bulunamadı.' });
    }

    if (activate) jeweler.status = 'ACTIVE';

    if (addCredits) {
        jeweler.membershipType = 'token';
        jeweler.credits = (jeweler.credits || 0) + Number(addCredits);
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

    res.json({ success: true, message: 'Kuyumcu hesabı güncellendi.', jeweler });
});

// Kuyumcu Durumu & Kalan Hak Sorgulama
app.get('/api/jeweler/status/:id', (req, res) => {
    const jeweler = JEWELERS_DIRECTORY.find(j => j.id === req.params.id);
    if (!jeweler) return res.status(404).json({ success: false, message: 'Kuyumcu bulunamadı.' });

    res.json({
        success: true,
        data: {
            id: jeweler.id,
            name: jeweler.name,
            status: jeweler.status,
            membershipType: jeweler.membershipType,
            credits: jeweler.credits,
            subscriptionExpiresAt: jeweler.subscriptionExpiresAt
        }
    });
});
// Tüm Başvuru & Kayıtlı Kuyumcuları Listele (Admin Paneli İçin)
app.get('/api/admin/jewelers', (req, res) => {
    res.json({ success: true, jewelers: JEWELERS_DIRECTORY });
});
// ================= İHALE & TEKLİF YÖNETİMİ =================

// 1. Yeni Satış İhalesi Başlatma & Sadece Bakiyeli/Aktif Sarraflara Dağıtım
app.post('/api/request/create', async (req, res) => {
    try {
        const reqData = req.body;
        if (!reqData || !reqData.requestId) {
            return res.status(400).json({ success: false, message: 'Geçersiz talep verisi' });
        }

        reqData.quotes = [];
        requestsPool.unshift(reqData);

        const targetCity = (reqData.city || 'Antalya').trim().toLowerCase();
        const targetDistrict = (reqData.district || '').trim().toLowerCase();
        const now = new Date();

        // SADECE: Aktif olan + Aynı il/ilçede olan + (Kredisi olan VEYA Aboneliği bitmemiş) Kuyumcular
        const matchedJewelers = JEWELERS_DIRECTORY.filter(j => {
            if (j.status !== 'ACTIVE') return false;
            if (j.city.toLowerCase() !== targetCity) return false;

            const districtMatch = !targetDistrict || (j.districts && j.districts.some(d => d.toLowerCase() === targetDistrict));
            if (!districtMatch) return false;

            // Bakiye / Üyelik Kontrolü
            if (j.membershipType === 'token') {
                return (j.credits || 0) > 0;
            } else if (j.membershipType === 'subscription') {
                return j.subscriptionExpiresAt && new Date(j.subscriptionExpiresAt) > now;
            }
            return false;
        });

        // Satılacak altınların listesi
        const itemsList = (reqData.items || []).map(it => 
            `• ${it.productName} (${it.karat}k) - ${it.grams ? it.grams + 'g' : ''} ${it.qty ? it.qty + ' adet' : ''}`
        ).join('\n');

        console.log(`[Dağıtım]: ${targetDistrict} bölgesinde ${matchedJewelers.length} hak sahibi sarrafa ihale iletiliyor...`);

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

        // Müşteriye bilgi teyidi
        if (reqData.customerPhone) {
            const customerMsg = `✅ *Altın Eksper:* #${reqData.requestId} nolu satış talebiniz ${reqData.district} bölgesindeki kayıtlı sarraflara iletildi. Teklifler toplanıyor, 15 dakika içinde en iyi teklif size bildirilecektir.`;
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

// 4. Sarraf Teklifi Ekleme (Jetonlu ise bakiyeden 1 hak düşer)
app.post('/api/request/quote', (req, res) => {
    const { requestId, jewelerCode, offerPrice, note } = req.body;
    console.log(`[Teklif Girişi]: #${requestId} için ${jewelerCode} -> ${offerPrice} TL`);

    const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
    if (!target) {
        return res.status(404).json({ success: false, message: 'Talep bulunamadı' });
    }

    // Teklifi veren kuyumcunun bakiye kontrolü
    const jeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerCode || j.name === jewelerCode);
    if (jeweler) {
        if (jeweler.status !== 'ACTIVE') {
            return res.status(403).json({ success: false, message: 'Üyeliğiniz aktif değil.' });
        }
        if (jeweler.membershipType === 'token' && jeweler.credits <= 0) {
            return res.status(403).json({ success: false, message: 'Yetersiz bakiye! Teklif vermek için paket yenileyin.' });
        }
    }

    target.quotes = target.quotes || [];
    const idx = target.quotes.findIndex(q => q.jewelerCode === jewelerCode);

    if (idx !== -1) {
        target.quotes[idx] = { jewelerCode, offerPrice: Number(offerPrice), note };
    } else {
        target.quotes.push({ jewelerCode, offerPrice: Number(offerPrice), note });
        // İlk teklif girişinde jetonlu üyeden 1 jeton düş
        if (jeweler && jeweler.membershipType === 'token' && jeweler.credits > 0) {
            jeweler.credits -= 1;
            console.log(`[Bakiye Düştü]: ${jeweler.name} kalan jeton: ${jeweler.credits}`);
        }
    }

    res.json({ success: true, quotes: target.quotes });
});

// 5. Kazanan Sarraf & Randevu Bildirimi
app.post('/api/request/notify-winner', async (req, res) => {
    try {
        const { requestId, jewelerCode, agreedPrice, customerName, customerPhone } = req.body;
        const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
        if (target) {
            target.status = 'COMPLETED';
            target.winnerCode = jewelerCode;
            target.agreedPrice = Number(agreedPrice);
            console.log(`[İhale Tamamlandı]: #${requestId} kazanan: ${jewelerCode}`);
        }

        const targetJeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerCode || j.name === jewelerCode);
        const jewelerPhone = targetJeweler ? targetJeweler.phone : WHATSAPP_CONFIG.adminPhone;

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