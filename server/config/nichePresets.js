/**
 * ==============================================================================
 * Multi-Niche Presets Configuration for ClipperVPS
 * Unifies Kitchen Tools & Gadget/Smartphone into a Single 9:16 Vertical Engine.
 * ==============================================================================
 */

export const NICHE_PRESETS = {
  kitchen_tools: {
    id: 'kitchen_tools',
    name: 'Alat Dapur & Kebutuhan Rumah',
    shortName: 'Alat Dapur',
    icon: '🍳',
    tagline: 'Video affiliate alat dapur, perabot praktis & pembersih faceless hands-on.',
    visualFocus: 'Demonstrasi alat dapur fisik pada bahan masakan, wajan, kompor, atau meja.',
    badgeColor: '#10b981',
    slotsConfig: [
      {
        slot: 1,
        key: 'clip1_full_product',
        fallbackKey: 'clip1',
        label: 'Visual Produk Utuh (Opening Hero)',
        role: 'full_product',
        datasetTag: 'valid_full_product',
        description: 'Tampilan fisik produk utuh pembuka di meja/dapur (Opening Hero Shot).'
      },
      {
        slot: 2,
        key: 'clip2_feature',
        fallbackKey: 'clip2',
        label: 'Fitur & Keunggulan Fisik',
        role: 'feature',
        datasetTag: 'valid_feature',
        description: 'Detail close-up material pisau, spons, stainless, pegangan, atau tombol.'
      },
      {
        slot: 3,
        key: 'clip3_action_demo',
        fallbackKey: 'clip3',
        label: 'Peragaan #1 (Aksi Produk)',
        role: 'action_demo',
        datasetTag: 'valid_action',
        description: 'Aksi penggunaan pertama mendemonstrasikan fungsi utama alat.'
      },
      {
        slot: 4,
        key: 'clip4_action_demo_diff',
        fallbackKey: 'clip4_action_demo',
        label: 'Peragaan #2 (Visual Berbeda / Angle Lain)',
        role: 'action_demo_diff',
        datasetTag: 'valid_action',
        description: 'Peragaan dari sudut kamera/objek berbeda. Wajib ganti visual agar tidak monoton.'
      },
      {
        slot: 5,
        key: 'clip5_action_demo',
        fallbackKey: 'clip5_result',
        label: 'Peragaan #3 (Hasil / Bukti Nyata)',
        role: 'action_demo',
        datasetTag: 'valid_result',
        description: 'Pembuktian hasil nyata: kinclong, bersih, potongan rapi, atau dibilas air.'
      },
      {
        slot: 6,
        key: 'clip6_full_product',
        fallbackKey: 'clip6',
        label: 'WAJIB Visual Produk Utuh (Penutup)',
        role: 'full_product',
        datasetTag: 'valid_full_product',
        description: 'Fisik produk utuh bersih ditaruh kembali di meja sebagai penutup yang meyakinkan.'
      },
      {
        slot: 7,
        key: 'clip7_full_product',
        fallbackKey: 'clip7_display_cta',
        label: 'WAJIB Visual Produk Utuh (Call to Action)',
        role: 'full_product',
        datasetTag: 'valid_display_cta',
        description: 'Produk ditata jelas di frame tengah selaras dengan ajakan checkout keranjang kuning.'
      }
    ],
    storyboardInstructions: `Petakan indeks frame ke dalam 7 peran "storyboard" berikut:
- "clip1_full_product": Slot 1 (00:00-00:05) -> VISUAL PRODUK UTUH (Opening Hero Shot). Frame yang memperlihatkan fisik produk secara utuh/lengkap di atas meja atau dipegang. Sesuai kategori: [valid_full_product]. BUKAN sedang digosok atau di-zoom ekstrem!
- "clip2_feature": Slot 2 (00:05-00:10) -> DETAIL FITUR & SPEK. Frame close-up yang menonjolkan fitur/material/komponen fisik alat (tekstur spons, jaring kawat, bahan stainless, pegangan, tombol). Sesuai kategori: [valid_feature].
- "clip3_action_demo": Slot 3 (00:10-00:15) -> PERAGAAN #1 (AKSI PAKAI). Aksi penggunaan alat pertama kali mendemonstrasikan fungsinya (misal: mulai menggosok noda/kotoran, memotong bahan). Sesuai kategori: [valid_action].
- "clip4_action_demo_diff": Slot 4 (00:15-00:20) -> PERAGAAN DENGAN VISUAL BERBEDA. Aksi peragaan dengan SUDUT KAMERA / ANGLE BERBEDA, atau pada permukaan/objek berbeda (misal wajan vs wastafel, angle samping vs angle atas). Wajib beda sudut dari Slot 3!
- "clip5_action_demo": Slot 5 (00:20-00:25) -> HASIL PERAGAAN / BUKTI BERSIH ("clip5_result"). Aksi peragaan pembuktian atau hasil (misal: dibilas air bersih, busa melimpah, dilap, atau perbandingan kinclong). Sesuai kategori: [valid_result].
- "clip6_full_product": Slot 6 (00:25-00:30) -> WAJIB VISUAL PRODUK UTUH. Tampilan fisik produk utuh kembali (misal produk bersih ditaruh di meja atau dipegang) sebagai penutup yang meyakinkan penonton. Sesuai kategori: [valid_full_product].
- "clip7_full_product": Slot 7 (00:30-00:35) -> WAJIB VISUAL PRODUK UTUH / DISPLAY CTA ("clip7_display_cta"). Tampilan fisik produk utuh yang selaras dengan ajakan checkout di keranjang kuning/oranye pojok kiri bawah. Sesuai kategori: [valid_display_cta] / [valid_full_product].`,
    hookGuidelines: `Hook naskah pembuka 3 detik harus solutif dan relate dengan kegiatan memasak, food prep, kerapian meja makan, atau masalah spesifik saat menyiapkan makanan (DILARANG menggunakan kata 'alat dapur' maupun 'Shopee', dan DILARANG pakai kata 'fix' / 'fiks'!).`,
    curatedHooks: [
      // 🍳 1. Tipe Solusi Masalah Memasak & Food Prep
      "Emak-emak wajib nonton! Ini solusi biar area masak enggak berantakan lagi.",
      "Capek banget tiap hari harus bersihin percikan minyak pas goreng? Sini berkumpul.",
      "Bikin sarapan jadi 2x lebih cepat cuma modal barang receh yang satu ini.",
      "Buat yang punya ruangan sempit, barang ini bener-bener penyelamat tempat banget!",
      "Solusi cerdas buat yang malas potong-potong bahan masakan sampai nangis.",

      // 🧼 2. Tipe Estetika & Kerapian Ruangan (Clean Vibes)
      "Bikin area makan kelihatan mewah kayak di drama Korea, padahal modalnya gak sampai 50 ribu!",
      "Nyesel baru tahu ada organizer se-aesthetic ini buat naruh bumbu-bumbu.",
      "Suasana rumah minimalis idaman dimulai dari satu barang kecil yang serbaguna ini.",
      "Transformasi meja masak yang berantakan jadi rapi instan cuma pakai ini.",
      "Spill barang rahasia yang bikin tempat food prep estetik dan betah dipandang.",

      // 💸 3. Tipe Racun Belanja & Worth It (FOMO)
      "Jangan checkout barang lain sebelum kalian lihat fungsi benda ini!",
      "Barang receh online tapi gunanya bener-bener di luar nalar pas dipakai.",
      "Racun belanja minggu ini: fungsional banget dan wajib punya minimal satu di rumah.",
      "Review jujur setelah sebulan pakai produk pemotong viral yang satu ini.",
      "Gak nyangka barang semurah ini bisa awet dan sekokoh ini buat harian.",

      // 🤫 4. Tipe Penasaran & Demo Visual (Faceless Friendly)
      "Bisa tebak gak benda sekecil ini fungsinya buat apa?",
      "Satu trik rahasia yang disembunyikin para ibu rumah tangga biar urusan masak cepat beres.",
      "Kenapa barang ini selalu sold out dan dapet rating bintang 5 terus ya?",
      "Tonton video ini sampai habis kalau mau tahu cara instan mengatasi minyak membandel.",
      "Ada yang aneh dari benda ini, kelihatannya simpel tapi kok bisa se-efektif ini?",

      // 📉 5. Tipe Perbandingan & Edukasi
      "Mending beli yang versi ini daripada versi lama yang harganya selangit tapi fungsinya sama.",
      "Battle kupas buah pakai cara viral vs manual, mana yang bikin kerjaan cepat beres?",
      "Jangan ketipu sama ukurannya yang kecil, lihat dulu pas dipakai buat potong daging.",
      "Ekspektasi vs Realita pas beli produk pembersih viral, ternyata...",
      "Kelebihan dan kekurangan produk ini yang wajib kamu tahu sebelum menyesal beli.",

      // ⏱️ 6. Tipe Urgensi & Dorongan Klik
      "Cuma sisa beberapa unit lagi, diskon flash sale buat barang ini mau habis!",
      "Uji coba langsung: beneran mempermudah food prep atau cuma gimmick iklan doang?",
      "Buruan cek keranjang kuning sebelum harganya naik normal besok pagi.",
      "Tantangan bikin cemilan praktis cuma pakai satu benda ini, kira-kira berhasil gak ya?",
      "Borong ini sekarang sebelum stoknya hilang lagi dari pasaran!"
    ],
    defaultKeywords: [
      // Top 35 High-Converting Viral Evergreen Kitchen Gadgets (Ribuan video faceless di YouTube/TikTok)
      'chopper manual tarik serbaguna viral',
      'chopper mini elektrik portable viral',
      'mandoline slicer parutan serbaguna',
      'alat pengupas kulit apel putar otomatis praktis',
      'garlic press rocker pemeras bawang putih stainless',
      'gunting dapur serbaguna stainless multifungsi',
      'oil pot wadah saringan minyak goreng stainless',
      'pemotong semangka melon praktis viral',
      'alat pengupas sisik ikan stainless praktis',
      'sealer plastik mini portable perekat makanan',
      'alat pembuat dumpling pastel manual',
      'parutan keju putar rotary cheese grater',
      'alat pemotong kentang french fries cutter',
      'alat pemeras jeruk lemon manual stainless',
      'batu asahan pisau roll serbaguna',
      'alat pemotong nanas spiral stainless',
      'sendok pembuat bakso bakwan anti lengket',
      'alat pengocok telur semi otomatis putar tekan',
      'alat pemipil jagung serbaguna praktis',
      'alat pembuka kaleng putar can opener praktis',
      'cetakan telur gulung tamagoyaki persegi',
      'wajan penggorengan mini telur 4 lubang anti lengket',
      'dispenser sabun cuci piring sponge holder',
      'alat pengiris daging beku manual slicer',
      'alat pemotong alpukat 3 in 1 praktis',
      'alat pengiris telur rebus kawat stainless',
      'alat peremas kentang stainless potato ricer',
      'gunting daun bawang sayur 5 lapis stainless',
      'sendok tirisan penggorengan stainless serbaguna',
      'wadah penyimpanan sayur kulkas drain basket',
      'botol minyak kuas silikon 2 in 1 anti tumpah',
      'alat pembersih kerak wajan serbaguna',
      'alat pelindung jari iris sayur stainless cutter guard',
      'alat pemecah cangkang kepiting walnut stainless',
      'panci listrik mini serbaguna portable'
    ]
  },

  gadget_smartphone: {
    id: 'gadget_smartphone',
    name: 'Smartphone & Gadget Viral',
    shortName: 'Smartphone',
    icon: '📱',
    tagline: 'Video affiliate review smartphone, spesifikasi, gaming & kamera B-roll faceless.',
    visualFocus: 'B-roll fisik smartphone di tangan: bodi belakang, modul kamera, layar AMOLED, navigasi smooth 120Hz, dan hasil jepretan kamera.',
    badgeColor: '#3b82f6',
    slotsConfig: [
      {
        slot: 1,
        key: 'clip1_full_product',
        fallbackKey: 'clip1',
        label: 'Desain Bodi Belakang & Modul Kamera (Hero)',
        role: 'full_product',
        datasetTag: 'valid_full_product',
        description: 'Tampilan fisik bodi belakang smartphone, warna gradasi, dan modul kamera estetik (Opening Hero).'
      },
      {
        slot: 2,
        key: 'clip2_feature',
        fallbackKey: 'clip2',
        label: 'Layar AMOLED Bezel Tipis / Port / Speaker',
        role: 'feature',
        datasetTag: 'valid_feature',
        description: 'Sorotan detail ketipisan bodi, bezel layar depan, speaker stereo, atau port charger Type-C.'
      },
      {
        slot: 3,
        key: 'clip3_action_demo',
        fallbackKey: 'clip3',
        label: 'Navigasi UI / Scrolling Sosmed Smooth 120Hz',
        role: 'action_demo',
        datasetTag: 'valid_action',
        description: 'Demonstrasi pengoperasian layar HP: scrolling feed sosmed, buka aplikasi cepat, refresh rate mulus.'
      },
      {
        slot: 4,
        key: 'clip4_action_demo_diff',
        fallbackKey: 'clip4_action_demo',
        label: 'Pengujian Performa / Gaming / Multitasking',
        role: 'action_demo_diff',
        datasetTag: 'valid_action',
        description: 'Aksi gameplay game (MLBB/PUBG) atau multitasking aplikasi berat membuktikan chipset kencang.'
      },
      {
        slot: 5,
        key: 'clip5_action_demo',
        fallbackKey: 'clip5_result',
        label: 'Pengujian Kamera / Hasil Foto & Video Jernih',
        role: 'action_demo',
        datasetTag: 'valid_result',
        description: 'Demonstrasi kamera: hasil foto portrait estetik, detail tajam, stabilisasi video, atau zoom OIS.'
      },
      {
        slot: 6,
        key: 'clip6_full_product',
        fallbackKey: 'clip6',
        label: 'Smartphone Digenggam di Tangan (Grip Penutup)',
        role: 'full_product',
        datasetTag: 'valid_full_product',
        description: 'Tampilan fisik HP seutuhnya saat digenggam pas di tangan secara premium dan meyakinkan.'
      },
      {
        slot: 7,
        key: 'clip7_full_product',
        fallbackKey: 'clip7_display_cta',
        label: 'Display Produk & Harga Miring (Call to Action)',
        role: 'full_product',
        datasetTag: 'valid_display_cta',
        description: 'HP ditaruh rapi menghadap kamera selaras dengan ajakan cek harga promo di keranjang kuning.'
      }
    ],
    storyboardInstructions: `Petakan indeks frame ke dalam 7 peran "storyboard" smartphone B-roll (WAJIB FACELESS, HAPUS WAJAH REVIEWER):
- "clip1_full_product": Slot 1 (00:00-00:05) -> DESAIN BODI BELAKANG & KAMERA (Opening Hero). Frame yang memperlihatkan fisik bodi belakang smartphone, pantulan warna, atau modul kamera yang mewah. Sesuai kategori: [valid_full_product]. DILARANG wajah reviewer talking-head!
- "clip2_feature": Slot 2 (00:05-00:10) -> DETAIL HARDWARE & LAYAR. Frame close-up yang menonjolkan bezel layar tipis, kelengkungan bodi, port charger Type-C, grill speaker stereo, atau sensor sidik jari. Sesuai kategori: [valid_feature].
- "clip3_action_demo": Slot 3 (00:10-00:15) -> NAVIGASI MENU / SCROLLING 120Hz. Tangan mengoperasikan HP: scrolling menu atau aplikasi secara lancar dan responsif. Sesuai kategori: [valid_action].
- "clip4_action_demo_diff": Slot 4 (00:15-00:20) -> PENGUJIAN GAMING / PERFORMA. Demo saat HP memainkan game berat (Mobile Legends, PUBG, Genshin) dengan frame rate stabil atau benchmark kencang. Sesuai kategori: [valid_action].
- "clip5_action_demo": Slot 5 (00:20-00:25) -> HASIL KAMERA & VIDEO ("clip5_result"). Frame yang memperlihatkan hasil jepretan kamera: foto tajam, warna jernih, bokeh rapi, atau layar preview kamera. Sesuai kategori: [valid_result].
- "clip6_full_product": Slot 6 (00:25-00:30) -> HP DIGENGGAM ELEGAN. Tampilan fisik HP seutuhnya saat dipegang di tangan pemakai secara elegan sebagai penutup. Sesuai kategori: [valid_full_product].
- "clip7_full_product": Slot 7 (00:30-00:35) -> DISPLAY PRODUK CTA ("clip7_display_cta"). HP ditata rapi menghadap kamera selaras dengan ajakan cek harga & keranjang diskon pojok kiri bawah. Sesuai kategori: [valid_display_cta] / [valid_full_product].`,
    hookGuidelines: `Hook naskah pembuka 3 detik harus menonjolkan spesifikasi gahar, harga miring terjangkau, layar AMOLED mulus 120Hz, atau kamera jernih anti-goyang (DILARANG pakai kata 'fix' / 'fiks'!).`,
    defaultKeywords: [
      'review infinix note 40 pro indonesia',
      'review poco x6 5g indonesia',
      'review redmi note 13 pro 5g indonesia',
      'review poco m6 pro indonesia',
      'review samsung galaxy a15 5g indonesia',
      'review samsung galaxy a25 5g indonesia',
      'review iqoo z9x 5g indonesia',
      'review iqoo z9 5g indonesia',
      'review realme 12 5g indonesia',
      'review realme 12 plus 5g indonesia',
      'review tecno pova 6 pro 5g indonesia',
      'review tecno camon 30 5g indonesia',
      'review vivo y100 5g indonesia',
      'review oppo reno 11f 5g indonesia',
      'review infinix gt 20 pro 5g indonesia',
      'review redmi note 14 pro 5g indonesia',
      'review poco f6 indonesia',
      'review samsung galaxy a35 5g indonesia',
      'review vivo v30e indonesia',
      'review realme 13 5g indonesia',
      'review tecno spark 20 pro plus indonesia',
      'review infinix hot 40 pro indonesia',
      'review samsung galaxy m15 5g indonesia',
      'review redmi note 13 5g indonesia',
      'review oppo a79 5g indonesia',
      'hp 2 jutaan terbaik kamera jernih ois',
      'hp gaming 2 jutaan performa kencang',
      'rekomendasi hp 2 jutaan layar amoled 120hz',
      'rekomendasi hp 3 jutaan kamera stabil ois',
      'spesifikasi hp 2 jutaan android terbaru',
      'review smartphone 2 jutaan baterai awet',
      'review hp gaming 3 jutaan chipset kencang',
      'rekomendasi hp 2 jutaan ram 8gb 256gb',
      'review kamera hp 2 jutaan hasil foto jernih',
      'review hp mid range terbaik 2 jutaan',
      'review smartphone layar lengkung 2 jutaan amoled',
      'hp 2 jutaan chipset snapdragon terkencang',
      'hp 2 jutaan chipset dimensity performa gaming',
      'rekomendasi hp 2 jutaan fast charging kencang',
      'review hp 2 jutaan kualitas kamera depan belakang',
      'rekomendasi hp 2 jutaan terbaik 2026',
      'review hp 3 jutaan layar 120hz performa flagship',
      'hp 2 jutaan speaker stereo nfc baterai 5000mah',
      'review hp 2 jutaan sensor sony kamera jernih',
      'rekomendasi hp mid range 2 jutaan tahan air',
      'rekomendasi hp 1 jutaan ram besar baterai awet',
      'review hp murah 1 jutaan layar 90hz gaming lancar',
      'hp 1 jutaan terbaik untuk ojek online gojek grab',
      'review tws murah bass mantap noise cancelling',
      'rekomendasi smartwatch murah baterai tahan 2 minggu'
    ]
  }
};

export const DEFAULT_NICHE_ID = 'kitchen_tools';

export function getNichePreset(nicheId) {
  const normalized = (nicheId || '').trim().toLowerCase();
  if (NICHE_PRESETS[normalized]) {
    return NICHE_PRESETS[normalized];
  }
  // Alias support
  if (normalized === 'gadget' || normalized === 'hp' || normalized === 'smartphone' || normalized === 'ytcliper') {
    return NICHE_PRESETS.gadget_smartphone;
  }
  if (normalized === 'kitchen' || normalized === 'dapur' || normalized === 'alat_dapur') {
    return NICHE_PRESETS.kitchen_tools;
  }
  return NICHE_PRESETS[DEFAULT_NICHE_ID];
}

export function getAllNiches() {
  return Object.values(NICHE_PRESETS).map(n => ({
    id: n.id,
    name: n.name,
    shortName: n.shortName,
    icon: n.icon,
    tagline: n.tagline,
    badgeColor: n.badgeColor,
    totalKeywords: n.defaultKeywords.length
  }));
}

/**
 * Generates combinatorial smartphone keywords on the fly
 */
export function generateCombinatorialGadgetKeywords(count = 100, excludedSet = new Set()) {
  const brands = [
    'Poco', 'Redmi Note', 'Infinix Note', 'Infinix GT', 'Infinix Hot',
    'Samsung Galaxy A', 'Samsung Galaxy M', 'Realme', 'Tecno Pova',
    'Tecno Camon', 'Tecno Spark', 'Vivo Y', 'Vivo V', 'iQOO Z'
  ];

  const series = [
    '13', '14', '15', '20 Pro', '30 5G', '40 Pro', '50 Pro', 'X6 5G', 'F6', 'M6 Pro'
  ];

  const aspects = [
    'review indonesia', 'tes kamera jernih ois', 'tes gaming pubg mlbb',
    'layar amoled 120hz', 'baterai awet fast charge', 'unboxing spesifikasi',
    'kelebihan dan kekurangan', 'hasil foto malam hari', 'performa chipset gaming'
  ];

  const priceSegments = [
    'hp 1 jutaan terbaik', 'hp 2 jutaan terbaik', 'hp 3 jutaan terbaik',
    'rekomendasi hp 2 jutaan gaming', 'hp 2 jutaan kamera stabil',
    'hp 2 jutaan layar lengkung', 'smartphone 2 jutaan ram 8gb 256gb'
  ];

  const results = new Set();

  for (const p of priceSegments) {
    for (const a of ['indonesia', '2026', 'kamera ois', 'layar 120hz']) {
      const q = `${p} ${a}`.trim();
      if (!excludedSet.has(q.toLowerCase())) {
        results.add(q);
        if (results.size >= count) return Array.from(results);
      }
    }
  }

  for (const b of brands) {
    for (const s of series) {
      for (const a of aspects) {
        const q = `review ${b} ${s} ${a}`.trim();
        if (!excludedSet.has(q.toLowerCase())) {
          results.add(q);
          if (results.size >= count) return Array.from(results);
        }
      }
    }
  }

  return Array.from(results);
}
