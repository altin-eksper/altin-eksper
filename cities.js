// Türkiye 81 İl ve İlçe Otomatik Çekme & Sıralama Motoru
let TURKEY_CITIES_DATA = {};

async function loadTurkeyCities() {
    try {
        const response = await fetch('https://raw.githubusercontent.com/nejdetkadir/il-ilce-rest-api/refs/heads/master/services/data.json');
        if (!response.ok) throw new Error("Ağ hatası");
        const list = await response.json();
        
        const temp = {};
        list.forEach(item => {
            const il = item.il_adi;
            const ilceler = (item.ilceler || []).map(d => d.ilce_adi).sort((a, b) => a.localeCompare(b, 'tr'));
            temp[il] = ilceler;
        });

        // 81 ili A'dan Z'ye Türkçe harf duyarlılığıyla sırala
        const sortedKeys = Object.keys(temp).sort((a, b) => a.localeCompare(b, 'tr'));
        sortedKeys.forEach(k => {
            TURKEY_CITIES_DATA[k] = temp[k];
        });

        // HTML içindeki dropdownları doldur
        if (typeof initCityDropdowns === 'function') {
            initCityDropdowns();
        }
    } catch (err) {
        console.warn('Online il listesi çekilemedi, yerel veri devreye girdi:', err);
        // Çevrimdışı / yedek durumunda temel iller
        TURKEY_CITIES_DATA = {
            "Antalya": ["Akseki", "Aksu", "Alanya", "Demre", "Döşemealtı", "Elmalı", "Finike", "Gazipaşa", "Gündoğmuş", "İbradı", "Kaş", "Kemer", "Kepez", "Konyaaltı", "Korkuteli", "Kumluca", "Manavgat", "Muratpaşa", "Serik"],
            "Ankara": ["Altındağ", "Çankaya", "Etimesgut", "Gölbaşı", "Keçiören", "Mamak", "Sincan", "Yenimahalle"],
            "İstanbul": ["Beşiktaş", "Kadıköy", "Şişli", "Üsküdar"],
            "İzmir": ["Bornova", "Karşıyaka", "Konak"]
        };
        if (typeof initCityDropdowns === 'function') {
            initCityDropdowns();
        }
    }
}

// Dosya tarayıcıda çağrılır çağrılmaz çalıştır
loadTurkeyCities();