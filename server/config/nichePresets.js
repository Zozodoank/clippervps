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
    outroBumper: 'kitchen_outro.mp4',
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
    storyboardInstructions: `Petakan indeks frame ke dalam 7 peran "storyboard" berikut (WAJIB MULTI-SOURCE: sebarkan ke 2-4 video kandidat berbeda jika tersedia, DILARANG hanya 1 video!):
- "clip1_full_product": Slot 1 (00:00-00:05) -> WAJIB VISUAL PRODUK UTUH (Opening Hero Shot). Frame yang memperlihatkan fisik produk secara utuh/lengkap di atas meja atau dipegang. Sesuai kategori: [valid_full_product]. DILARANG KERAS sedang digosok, diperas, dipotong, atau aksi ekstrem di Slot 1!
- "clip2_feature": Slot 2 (00:05-00:10) -> DETAIL FITUR & SPEK. Frame close-up yang menonjolkan fitur/material/komponen fisik alat (tekstur spons, jaring kawat, bahan stainless, pegangan, tombol). Sesuai kategori: [valid_feature].
- "clip3_action_demo": Slot 3 (00:10-00:15) -> PERAGAAN #1 (AKSI PAKAI). Aksi penggunaan alat pertama kali mendemonstrasikan fungsinya (misal: mulai menggosok noda/kotoran, memotong bahan). Sesuai kategori: [valid_action].
- "clip4_action_demo_diff": Slot 4 (00:15-00:20) -> PERAGAAN DENGAN VISUAL BERBEDA (WAJIB KANDIDAT VIDEO BERBEDA). Aksi peragaan dengan SUDUT KAMERA / ANGLE BERBEDA dari kandidat video lain. Wajib beda video/sudut dari Slot 3!
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
    name: 'Smartphone Flagship & Mid-Range',
    shortName: 'Smartphone',
    icon: '📱',
    tagline: 'Video YouTube Shorts review smartphone, spesifikasi kencang, gaming & B-roll kamera faceless.',
    visualFocus: 'B-roll fisik smartphone: bodi belakang mewah, bezel layar tipis, scrolling AMOLED 120Hz, performa gaming, dan uji kamera outdoor/still photo.',
    badgeColor: '#3b82f6',
    outroBumper: 'gadget_outro.mp4',
    strictSceneVoSync: true,
    // Smartphone: 1 video terverifikasi LANGSUNG diproses; jangan paksa harvesting
    // sumber ke-2 (b-roll faceless HP langka -> kandidat berikutnya terus di-skip & kuota terbuang).
    minVerifiedSources: 1,
    slotsConfig: [
      {
        slot: 1,
        key: 'clip1_full_product',
        fallbackKey: 'clip1',
        label: 'Desain Bodi Belakang & Modul Kamera (Hero)',
        role: 'full_product',
        datasetTag: 'valid_full_product',
        description: 'Tampilan fisik bodi belakang smartphone, pantulan warna, dan modul kamera estetik (Opening Hero).'
      },
      {
        slot: 2,
        key: 'clip2_feature',
        fallbackKey: 'clip2',
        label: 'Layar Bezel Tipis & Build Quality Bodi Kokoh',
        role: 'feature',
        datasetTag: 'valid_feature',
        description: 'Sorotan detail ketipisan bodi, frame aluminium/polikarbonat kokoh, bezel layar tipis, speaker, atau port Type-C.'
      },
      {
        slot: 3,
        key: 'clip3_action_demo',
        fallbackKey: 'clip3',
        label: 'Layar AMOLED 120Hz Mulus & Navigasi Antarmuka',
        role: 'action_demo',
        datasetTag: 'valid_action',
        description: 'Demonstrasi pengoperasian layar HP: scrolling sosmed super mulus 120Hz, transisi aplikasi gesit tanpa patah-patah.'
      },
      {
        slot: 4,
        key: 'clip4_action_demo_diff',
        fallbackKey: 'clip4_action_demo',
        label: 'Performa Kencang, RAM & Memori Lega',
        role: 'action_demo_diff',
        datasetTag: 'valid_action',
        description: 'Gameplay game (MLBB/PUBG) atau multitasking membuktikan chipset Snapdragon/Dimensity, RAM 8GB, dan internal 256/512GB (bebas istilah GPU rumit).'
      },
      {
        slot: 5,
        key: 'clip5_action_demo',
        fallbackKey: 'clip5_result',
        label: 'Uji Kamera Jernih: Video 4K & Foto Tajam',
        role: 'action_demo',
        datasetTag: 'valid_result',
        description: 'Demonstrasi kamera: rekaman video stabil 4K 30fps atau sample foto jepretan malam/portrait jernih (didukung still photo zoom).',
        facePolicy: 'presenter_only'
      },
      {
        slot: 6,
        key: 'clip6_full_product',
        fallbackKey: 'clip6',
        label: 'Daya Tahan Baterai & Fast Charging Seharian',
        role: 'full_product',
        datasetTag: 'valid_full_product',
        description: 'Ketahanan baterai awet seharian, adapter charger fast charging ngebut, dan fisik HP digenggam pas di tangan.'
      },
      {
        slot: 7,
        key: 'clip7_full_product',
        fallbackKey: 'clip7_display_cta',
        label: 'Soft CTA: Kisaran Harga & Lempar Diskusi Penonton',
        role: 'full_product',
        datasetTag: 'valid_display_cta',
        description: 'Fisik HP ditata elegan selaras dengan informasi kisaran harga (Rp / Yuan) dan ajakan berpendapat di kolom komentar (tanpa kata Shopee/beli).'
      }
    ],
    storyboardInstructions: `Petakan indeks frame ke dalam 7 peran "storyboard" smartphone B-roll (WAJIB FACELESS, TOLAK WAJAH VLOGGER TALKING-HEAD):
- "clip1_full_product": Slot 1 (00:00-00:06) -> DESAIN BODI BELAKANG & KAMERA (Opening Hero). Frame bodi belakang smartphone, kilau warna gradasi, atau modul kamera yang mewah. Sesuai kategori: [valid_full_product]. DILARANG wajah reviewer talking-head di studio!
- "clip2_feature": Slot 2 (00:06-00:13) -> DETAIL BEZEL LAYAR & FRAME KOKOH. Frame close-up bezel layar tipis, material frame aluminium/solid agar tidak gampang panas/tergores, serta port Type-C. Sesuai kategori: [valid_feature].
- "clip3_action_demo": Slot 3 (00:13-00:20) -> NAVIGASI UI & LAYAR 120Hz. Layar aktif menampilkan scrolling sosmed atau antarmuka OS yang super mulus responsif. Sesuai kategori: [valid_action].
- "clip4_action_demo_diff": Slot 4 (00:20-00:27) -> PERFORMA KENCANG & MULTITASKING. Cuplikan gameplay game atau buka tutup aplikasi cepat yang membuktikan performa chipset Snapdragon/Dimensity, RAM 8GB LPDDR4, dan internal 256/512GB (JANGAN sebut istilah GPU rumit). Sesuai kategori: [valid_action].
- "clip5_action_demo": Slot 5 (00:27-00:34) -> UJI KAMERA & STILL PHOTO ("clip5_result"). Cuplikan hasil rekaman video outdoor 4K atau sample foto jepretan kamera yang tajam dan natural (wajah pejalan kaki jauh / foto portrait diizinkan). Sesuai kategori: [valid_result].
- "clip6_full_product": Slot 6 (00:34-00:41) -> BATERAI AWET & FAST CHARGING. Frame HP saat di-charge atau bodi utuh yang menekankan baterai awet seharian. Sesuai kategori: [valid_full_product].
- "clip7_full_product": Slot 7 (00:41-00:48) -> DISPLAY SOFT CTA ("clip7_display_cta"). Tampilan HP diletakkan rapi selaras dengan perkiraan kisaran harga (Rupiah atau konversi Yuan) serta pancingan interaksi penonton: "Menurut kalian worth it gak? Komen di bawah ya!". DILARANG menggunakan kata Shopee, keranjang kuning, atau ajakan membeli langsung! Sesuai kategori: [valid_display_cta] / [valid_full_product].`,
    hookGuidelines: `Hook naskah pembuka 3 detik harus memancing rasa penasaran penonton YouTube Shorts mengenai keunggulan bodi, layar 120Hz mulus, performa kencang anti lag, atau value for money smartphone (DILARANG menggunakan kata 'alat dapur', 'Shopee', 'keranjang kuning', dan DILARANG pakai kata 'fix' / 'fiks'!).`,
    curatedSoftCtas: [
      "Untuk varian RAM 8 dan internal 256GB, harganya ada di kisaran 3 jutaan. Menurut kalian dengan spek kayak gini worth it gak? Coba tulis pendapat kalian di kolom komentar ya!",
      "Di negara asalnya HP ini baru rilis sekitar 2.000 Yuan atau kalau dirupiahkan kisaran 4 jutaan. Kira-kira kalau resmi masuk sini, kalian tertarik beli gak nih?",
      "Dengan harga di kisaran 2 jutaan kecil, HP ini udah dapet layar AMOLED 120Hz dan chipset kencang. Menurut kalian worth it banget gak? Tulis di komentar ya!",
      "Harganya dipatok di kisaran 3 sampai 4 jutaan. Menurut kalian mending ambil HP ini atau nunggu seri saingannya rilis? Diskusi di kolom komentar yuk!",
      "Buat harga di kisaran 2 jutaan, kameranya udah stabil dan baterainya badak seharian. Gimana menurut kalian, cocok gak buat daily driver? Coba komen di bawah!"
    ],
    curatedHooks: [
      // ⚡ 1. Tipe Performa & Anti Lemot (Chipset & Layar 120Hz)
      "Capek pakai HP yang gampang patah-patah pas scrolling? Smartphone yang satu ini mulusnya kebangetan!",
      "HP harga terjangkau tapi pas dipakai gaming rasanya kayak pakai HP belasan juta.",
      "Jangan kaget kalau scrolling sosmed di HP ini bakal bikin mata kalian nyaman banget seharian.",
      "Buat kalian yang butuh HP kencang anti lemot buat harian, smartphone ini wajib masuk wishlist.",
      "Chipset kencang dipadu layar 120Hz, kombinasi yang bikin aktivitas harian sat-set tanpa jeda.",

      // 📸 2. Tipe Kamera & Visual Jernih
      "Siapa sangka HP di kelas harga segini bisa ngasilin rekaman video 4K yang stabil begini?",
      "Hasil jepretan kamera smartphone ini detailnya tajam banget, bahkan pas dipakai motret malam hari.",
      "Buat yang suka bikin konten video tapi budget pas-pasan, kualitas kamera HP ini bener-bener di luar nalar.",
      "Warna fotonya natural dan fokusnya gesit, pas banget buat kalian yang hobi street photography.",
      "Kamera jernih anti goyang di HP ini bikin hasil video kalian kelihatan kayak pakai kamera profesional.",

      // 💎 3. Tipe Desain Mewah & Build Quality
      "Lihat bodi belakangnya! Tampilannya mewah dan bezel layarnya bener-bener setipis ini.",
      "Frame bodi kokoh dan finishing elegan yang bikin HP ini berasa solid banget pas digenggam.",
      "Banyak yang ngira ini HP flagship mahal, padahal harganya jauh lebih ramah di kantong.",
      "Desain tipis ringan tapi tetap kokoh, smartphone ini pas banget buat kalian yang suka gaya minimalis modern.",
      "Finishing bodi belakangnya tahan goresan halus dan gak gampang ninggalin bekas sidik jari.",

      // 🔋 4. Tipe Baterai & Daya Tahan
      "Baterai badak seharian dipadu pengisian daya kilat, bye-bye rasa panik kehabisan baterai di jalan!",
      "Dipakai kerja seharian dari pagi sampai malam, baterai HP ini masih nyisa banyak banget.",
      "Cuma butuh waktu sebentar buat ngecas, baterainya udah siap nemenin aktivitas kalian lagi.",
      "Buat yang mobilitasnya tinggi di luar ruangan, daya tahan baterai HP ini bener-bener bisa diandalkan.",
      "Manajemen daya yang efisien bikin bodi HP tetap adem walau dipakai seharian penuh.",

      // 💰 5. Tipe Value for Money & Penasaran
      "Bocoran smartphone yang bakal jadi rebutan banyak orang karena speknya yang kelewat royal!",
      "Punya memori internal super lega dan performa kencang, smartphone ini siap jadi raja di kelasnya.",
      "Sebelum kalian mutusin ganti HP baru, tonton dulu kemampuan smartphone yang satu ini sampai habis.",
      "Kombinasi spek juara dan tampilan premium, apakah HP ini bakal jadi yang terbaik di tahun ini?",
      "Dengan spek selengkap ini, kira-kira berapa ya kisaran harga pasarnya? Simak sampai akhir!"
    ],
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
      'review itel p55 5g indonesia hp 1 jutaan terkencang',
      'review itel s23 plus indonesia layar amoled lengkung',
      'review tecno spark 20c indonesia hp sejutaan',
      'review infinix smart 8 indonesia hp murah kekinian',
      'review poco c65 indonesia hp gaming murah',
      'review redmi a3 indonesia hp murah desain premium',
      'review realme note 50 indonesia hp sejutaan awet',
      'review zte blade a54 indonesia hp murah ram besar',
      'review nubia neo 2 5g indonesia hp gaming terjangkau'
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
 * Focused specifically on budget, mid-range & viral smartphones (NO laptops or non-phone gadgets).
 */
export function generateCombinatorialGadgetKeywords(count = 100, excludedSet = new Set()) {
  const brands = [
    'itel', 'Infinix Note', 'Infinix Hot', 'Infinix Smart', 'Infinix GT',
    'Tecno Spark', 'Tecno Pova', 'Tecno Camon', 'Tecno Pop',
    'Poco', 'Redmi Note', 'Redmi', 'Realme C', 'Realme Note', 'Realme',
    'Samsung Galaxy A', 'Samsung Galaxy M',
    'Vivo Y', 'Vivo V', 'iQOO Z',
    'Oppo A', 'ZTE Blade', 'Nubia Neo'
  ];

  const series = [
    'P55 5G', 'S23 Plus', 'A70', 'Color Pro',
    'Smart 8', 'Smart 9', 'Hot 40 Pro', 'Hot 50', 'Note 40 Pro', 'GT 20 Pro',
    'Spark 20', 'Spark 20C', 'Spark 20 Pro', 'Pop 8', 'Pova 6 Pro', 'Camon 30',
    'C65', 'M6 Pro', 'X6 5G', 'F6',
    '13C', '14C', 'A3', 'Note 13 5G', 'Note 14 Pro',
    'C53', 'C67', 'Note 50', 'Note 60', '12 5G',
    'A05s', 'A15 5G', 'A25 5G', 'A35 5G', 'M15 5G',
    'Y03', 'Y17s', 'Y28', 'Y100 5G', 'V30e',
    'Z9x 5G', 'Z9 5G',
    'A18', 'A38', 'A58', 'A79 5G',
    'A54', 'V50 Design', '2 5G'
  ];

  const aspects = [
    'review indonesia', 'tes kamera jernih ois', 'tes gaming pubg mlbb',
    'layar amoled 120hz', 'baterai awet fast charge', 'unboxing spesifikasi',
    'kelebihan dan kekurangan', 'hasil foto malam hari', 'performa chipset gaming'
  ];

  const priceSegments = [
    'hp 1 jutaan terbaik', 'hp 2 jutaan terbaik', 'hp 3 jutaan terbaik',
    'rekomendasi hp 2 jutaan gaming', 'hp 2 jutaan kamera stabil',
    'hp 2 jutaan layar lengkung', 'smartphone 2 jutaan ram 8gb 256gb',
    'rekomendasi hp murah 1 jutaan', 'hp murah spek dewa'
  ];

  const results = new Set();

  for (const p of priceSegments) {
    for (const a of ['indonesia', '2026', 'kamera ois', 'layar 120hz', 'baterai awet']) {
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

/**
 * Returns the facePolicy for a specific slot key within a niche preset.
 * Defaults to 'strict' (standard blocking behaviour) if the slot does not
 * declare an explicit facePolicy — ensuring kitchen_tools and any future
 * niche without the field are completely unaffected.
 *
 * @param {object} nichePreset - A resolved preset object from getNichePreset().
 * @param {string} slotKey    - The slot key, e.g. 'clip5_action_demo'.
 * @returns {'strict'|'presenter_only'} The effective face policy for that slot.
 */
export function getSlotFacePolicy(nichePreset, slotKey) {
  if (!nichePreset || !Array.isArray(nichePreset.slotsConfig)) return 'strict';
  const slot = nichePreset.slotsConfig.find(s => s.key === slotKey);
  return (slot && slot.facePolicy) ? slot.facePolicy : 'strict';
}
