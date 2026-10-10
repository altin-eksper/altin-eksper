const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================= AYARLAR & GELİR MOTORU =================
// Başarılı anlaşma tamamlandığında kazanan kuyumcudan düşülecek jeton sayısı
// (İleride dilediğiniz gibi sadece bu rakamı değiştirebilirsiniz)
const SUCCESS_DEAL_TOKEN_COST = 5; 

// ================= META WHATSAPP CLOUD API AYARLARI =================
const WHATSAPP_CONFIG = {
    phoneNumberId: '1293164497207661',
    accessToken: 'EAAY3ClF5SXgBSgKOGZAf4f2hIzEYFjjbLMmOpQ790tWqSYKnFCrCpKUgp8It3BAAPZCXhIGpIXWHlz0MhOd2ZCeE7tWxyOlUc9rGH0QbOyFpnvNZCIZAbtpVOa4NOZBg9DKrWUOd6MfqXPttArAyeAkzUc6dN9GyfmWWSR0eBoJnt95qMdR65QDRtHZC4hOWzi47QZDZD',
    apiVersion: 'v21.0',
    adminPhone: '905399321893' // Sistem yöneticisi WhatsApp bildirim hattı
};

// ================= ONAYLI & BAKİYELİ KUYUMCULAR LİSTESİ =================
let JEWELERS_DIRECTORY = [
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

// Bekleyen Ödeme Talepleri Deposu
let pendingPayments = [];

// Tamamlanan Başarılı Anlaşmalar & Komisyon Havuzu
let completedDeals = [];

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
            address: `${district || 'Merkez'} / ${city || 'Antalya'}`,
            membershipType: planType === 'subscription' ? 'subscription' : 'token',
            credits: 0,
            subscriptionExpiresAt: null,
            status: 'PENDING'
        };

        JEWELERS_DIRECTORY.push(newJeweler);

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

app.post('/api/admin/jeweler/topup', (req, res) => {
    const { jewelerId, addCredits, extendDays, activate } = req.body;
    const jeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerId || j.name === jewelerId);

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
            subscriptionExpiresAt: jeweler.subscriptionExpiresAt,
            address: jeweler.address || ''
        }
    });
});

app.get('/api/admin/jewelers', (req, res) => {
    res.json({ success: true, jewelers: JEWELERS_DIRECTORY });
});

// ================= ÖDEME & JETON SATIN ALMA ALTYAPISI =================

app.post('/api/jeweler/purchase-package', async (req, res) => {
    try {
        const { jewelerId, packageId, paymentMethod, senderName, note } = req.body;
        const jeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerId || j.name === jewelerId);

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

app.get('/api/admin/payments', (req, res) => {
    res.json({ success: true, payments: pendingPayments });
});

app.post('/api/admin/payment/approve', async (req, res) => {
    try {
        const { orderId } = req.body;
        const order = pendingPayments.find(p => p.orderId === orderId);

        if (!order) {
            return res.status(404).json({ success: false, message: 'Sipariş bulunamadı.' });
        }

        const jeweler = JEWELERS_DIRECTORY.find(j => j.id === order.jewelerId);
        if (!jeweler) {
            return res.status(404).json({ success: false, message: 'İlgili kuyumcu hesabı bulunamadı.' });
        }

        jeweler.status = 'ACTIVE';

        if (order.packageId === 'token_25') {
            jeweler.membershipType = 'token';
            jeweler.credits = (jeweler.credits || 0) + 25;
        } else if (order.packageId === 'token_75') {
            jeweler.membershipType = 'token';
            jeweler.credits = (jeweler.credits || 0) + 75;
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

        reqData.quotes = [];
        requestsPool.unshift(reqData);

        const targetDistrictRaw = (reqData.district || '').trim().toLowerCase();
        const now = new Date();

        // Esnek İlçe ve Bölge Eşleştirmesi
        const matchedJewelers = JEWELERS_DIRECTORY.filter(j => {
            if (j.status !== 'ACTIVE') return false;

            // İlçe filtresi
            const hasDistrictMatch = !targetDistrictRaw || (j.districts && j.districts.some(d => {
                const cleanD = d.toLowerCase();
                return targetDistrictRaw.includes(cleanD) || cleanD.includes(targetDistrictRaw);
            }));

            if (!hasDistrictMatch) return false;

            // Bakiye veya Üyelik Kontrolü
            if (j.membershipType === 'token') {
                return (j.credits || 0) > 0;
            } else if (j.membershipType === 'subscription') {
                return j.subscriptionExpiresAt && new Date(j.subscriptionExpiresAt) > now;
            }
            return false;
        });

        const itemsList = (reqData.items || []).map(it => 
            `• ${it.productName} (${it.karat}k) - ${it.grams ? it.grams + 'g' : ''} ${it.qty ? it.qty + ' adet' : ''}`
        ).join('\n');

        console.log(`[Dağıtım]: #${reqData.requestId} için ${matchedJewelers.length} sarrafa WhatsApp gönderiliyor...`);

        // Kuyumculara İhale Linki Gönder
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

        // Müşteriye Bilgi Mesajı Gönder
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

app.get('/api/requests', (req, res) => {
    const now = Date.now();
    const active = requestsPool.filter(r => !r.expiresAt || new Date(r.expiresAt).getTime() > now);
    res.json({ success: true, requests: active });
});

app.get('/api/request/:id', (req, res) => {
    const found = requestsPool.find(r => String(r.requestId) === String(req.params.id));
    if (!found) return res.status(404).json({ success: false, message: 'Talep bulunamadı' });
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

    const jeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerCode || j.name === jewelerCode);
    if (jeweler) {
        if (jeweler.status !== 'ACTIVE') {
            return res.status(403).json({ success: false, message: 'Üyeliğiniz aktif değil.' });
        }
    }

    target.quotes = target.quotes || [];
    const idx = target.quotes.findIndex(q => q.jewelerCode === jewelerCode);

    if (idx !== -1) {
        // AYNI KUYUMCU TEKLİFİNİ REVİZE EDİYOR (Tekrar jeton düşmez!)
        target.quotes[idx] = { 
            jewelerCode, 
            offerPrice: Number(offerPrice), 
            note: note || target.quotes[idx].note,
            updatedAt: new Date().toISOString()
        };
        console.log(`[Teklif Revize Edildi]: ${jewelerCode} yeni teklif: ${offerPrice} TL`);
    } else {
        // İLK KEZ TEKLİF VERİLİYOR (Jeton kontrolü ve düşümü)
        if (jeweler && jeweler.membershipType === 'token') {
            if (jeweler.credits <= 0) {
                return res.status(403).json({ success: false, message: 'Yetersiz bakiye! Teklif vermek için paket yenileyin.' });
            }
            jeweler.credits -= 1;
            console.log(`[Bakiye Düştü]: ${jeweler.name} teklif için 1 jeton harcadı. Kalan jeton: ${jeweler.credits}`);
        }

        target.quotes.push({ 
            jewelerCode, 
            offerPrice: Number(offerPrice), 
            note, 
            createdAt: new Date().toISOString() 
        });
    }

    res.json({ 
        success: true, 
        quotes: target.quotes, 
        remainingCredits: jeweler ? jeweler.credits : null 
    });
});

// ================= İHALE ONAYI, RANDEVU & BAŞARI JETONU DÜŞÜMÜ =================
app.post('/api/request/notify-winner', async (req, res) => {
    try {
        const { requestId, jewelerCode, agreedPrice, customerName, customerPhone, commissionTL } = req.body;
        const target = requestsPool.find(r => String(r.requestId).trim() === String(requestId).trim());
        
        if (target) {
            target.status = 'COMPLETED';
            target.winnerCode = jewelerCode;
            target.agreedPrice = Number(agreedPrice);
            console.log(`[İhale Tamamlandı]: #${requestId} kazanan: ${jewelerCode}`);
        }

        const targetJeweler = JEWELERS_DIRECTORY.find(j => j.id === jewelerCode || j.name === jewelerCode);
        const jewelerPhone = targetJeweler ? targetJeweler.phone : WHATSAPP_CONFIG.adminPhone;
        const jewelerName = targetJeweler ? targetJeweler.name : jewelerCode;
        const jewelerAddress = (targetJeweler && targetJeweler.address) ? targetJeweler.address : 'Muratpaşa / Antalya';
        const mapUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(jewelerAddress);

        // --- BAŞARI JETON DÜŞÜMÜ & KOMİSYON İŞLEMESİ ---
        let deductedTokens = 0;
        let remainingCredits = null;

        if (targetJeweler && targetJeweler.membershipType === 'token') {
            deductedTokens = SUCCESS_DEAL_TOKEN_COST;
            targetJeweler.credits = Math.max(0, (targetJeweler.credits || 0) - SUCCESS_DEAL_TOKEN_COST);
            remainingCredits = targetJeweler.credits;

            console.log(`[Başarı Jetonu Kesildi]: ${targetJeweler.name} hesabından ${SUCCESS_DEAL_TOKEN_COST} jeton düşüldü. Kalan Bakiye: ${targetJeweler.credits}`);
        }

        // Başarılı anlaşmayı muhasebe havuzuna kaydet
        const dealRecord = {
            dealId: 'DL_' + Date.now().toString().slice(-6),
            requestId,
            customerName: customerName || 'Müşteri',
            customerPhone: customerPhone || '',
            jewelerId: targetJeweler ? targetJeweler.id : jewelerCode,
            jewelerName: jewelerName,
            jewelerPhone: jewelerPhone,
            jewelerAddress: jewelerAddress,
            agreedPrice: Number(agreedPrice),
            deductedTokens: deductedTokens,
            remainingCredits: remainingCredits,
            commissionTL: Number(commissionTL) || 0,
            completedAt: new Date().toISOString()
        };
        completedDeals.unshift(dealRecord);

        // 1. Kazanan Sarrafa WhatsApp Bildirimi
        const tokenDeductNote = (targetJeweler && targetJeweler.membershipType === 'token')
            ? `🪙 *Kullanılan Başarı Jetonu:* ${SUCCESS_DEAL_TOKEN_COST} Adet\n🪙 *Kalan Jeton Bakiyeniz:* ${targetJeweler.credits}`
            : `👑 *Üyelik Durumu:* VIP Sınırsız Paket`;

        const winnerMessage = 
`🎉 *TEBRİKLER! İHALE SİZDE KALDI*

Sayın *${jewelerName}*, verdiğiniz teklif müşteri tarafından onaylandı!

🏷 *İhale No:* #${requestId}
👤 *Müşteri Adı:* ${customerName || 'Müşteri'}
💰 *Anlaşılan Tutar:* ${Number(agreedPrice).toLocaleString('tr-TR')} ₺
📌 *Müşteri İletişim:* ${customerPhone || 'Girilmedi'}
${tokenDeductNote}

Müşteriye mağazanızın açık adresi, harita konumu ve randevu kodu tanımlandı. Müşteri kısa süre içinde mağazanıza gelecektir.`;

        await sendWhatsAppMessage(jewelerPhone, winnerMessage);

        // 2. Müşteriye WhatsApp Randevu & Konum Fişi Bildirimi
        if (customerPhone) {
            const customerAppointmentMsg = 
`🎉 *TEBRİKLER! İŞLEMİNİZ ONAYLANDI*

Sayın *${customerName || 'Müşterimiz'}*, altın satış işleminiz için anlaşmalı sarrafımız bilgilendirildi.

🏪 *Yetkili Sarraf:* ${jewelerName}
💰 *Taahhüt Edilen Tutar:* ${Number(agreedPrice).toLocaleString('tr-TR')} ₺
📍 *Mağaza Adresi:* ${jewelerAddress}
🎟️ *Güvenlik / Randevu Kodu:* #${requestId}

🗺️ *Google Haritalar Yol Tarifi:*
${mapUrl}

📌 Mağazada fiziki tartım ve ayar teyidinden sonra ödemeniz anında nakit veya IBAN ile eksiksiz ödenecektir.`;

            await sendWhatsAppMessage(customerPhone, customerAppointmentMsg);
        }

        res.json({ 
            success: true, 
            message: 'Kazanan sarrafa ve müşteriye randevu bildirimleri iletildi. Başarı jetonu düşüldü.',
            deal: dealRecord,
            remainingCredits: remainingCredits
        });
    } catch (err) {
        console.error('Notify winner error:', err);
        res.status(500).json({ success: false, message: 'Bildirim gönderilemedi.' });
    }
});

// ================= KOMİSYON & BAŞARILI İHALE MUHASEBE RAPORU =================
app.get('/api/admin/commission-report', (req, res) => {
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
            totalTokensUsed
        },
        deals: completedDeals
    });
});

app.listen(PORT, () => {
    console.log(`Altın Eksper API Sunucusu ${PORT} portunda çalışıyor.`);
});