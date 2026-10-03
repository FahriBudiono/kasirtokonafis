/**
 * POS Kasir & Stok Toko Kelontong - Frontend App
 * Mendukung navigasi keyboard cepat (F2, F4, F8, F9, Enter, Esc),
 * scan barcode instan, kalkulator kembalian otomatis, dan cetak struk.
 */

// State Aplikasi
let cart = [];
let paymentMethod = 'cash';
let lastTransaction = null;
let audioCtx = null;

// Helper: Format Mata Uang Rupiah
function formatRupiah(amount) {
  const num = Math.round(Number(amount) || 0);
  return 'Rp ' + num.toLocaleString('id-ID');
}

// Suara Beep Sintetis (Web Audio API)
function playTone(freq = 1200, type = 'sine', duration = 0.08) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {
    // Abaikan jika browser memblokir audio autoplay
  }
}

function playScanSuccess() {
  playTone(1400, 'sine', 0.06);
}

function playCheckoutSuccess() {
  playTone(800, 'sine', 0.08);
  setTimeout(() => playTone(1200, 'sine', 0.12), 100);
}

// ----------------------------------------------------
// INISIALISASI SAAT DOM READY
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  loadQuickProducts();
  setupEventListeners();
  setupKeyboardHotkeys();
  renderCart();
});

// Jam Digital Realtime
function initClock() {
  const clockEl = document.getElementById('clock');
  const update = () => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour12: false }) + ' WIB';
    if (clockEl) clockEl.textContent = timeStr;
  };
  update();
  setInterval(update, 1000);
}

// ----------------------------------------------------
// PRODUK CEPAT SEMBAKO (QUICK BUTTONS)
// ----------------------------------------------------
async function loadQuickProducts() {
  const container = document.getElementById('quick-products');
  if (!container) return;

  try {
    const res = await fetch('/api/products');
    const result = await res.json();
    if (!result.success || !result.data) return;

    const products = result.data.slice(0, 12);
    container.innerHTML = '';

    products.forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'p-2 bg-slate-50 hover:bg-emerald-50 active:bg-emerald-100 border border-slate-200 hover:border-emerald-300 rounded-lg text-left transition flex flex-col justify-between group';
      
      const stockBadgeColor = p.stock <= 5 ? 'text-rose-600 bg-rose-50' : 'text-slate-400 bg-slate-100';
      
      btn.innerHTML = `
        <span class="text-xs font-semibold text-slate-800 line-clamp-1 group-hover:text-emerald-800">${p.name}</span>
        <div class="mt-1 flex items-center justify-between text-[11px]">
          <span class="font-bold text-emerald-700">${formatRupiah(p.selling_price)}</span>
          <span class="text-[10px] px-1 py-0.2 rounded ${stockBadgeColor}">Stok: ${p.stock}</span>
        </div>
      `;
      btn.addEventListener('click', () => {
        addToCart(p, 1);
        focusBarcodeInput();
      });
      container.appendChild(btn);
    });
  } catch (err) {
    console.error('Gagal memuat item cepat:', err);
  }
}

// ----------------------------------------------------
// PENCARIAN & SCAN BARCODE
// ----------------------------------------------------
let searchDebounceTimer = null;
const barcodeInput = document.getElementById('barcode-input');
const searchDropdown = document.getElementById('search-dropdown');

function setupEventListeners() {
  // Input Barcode / Search
  barcodeInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    const query = e.target.value.trim();
    if (!query) {
      searchDropdown.classList.add('hidden');
      searchDropdown.innerHTML = '';
      return;
    }
    searchDebounceTimer = setTimeout(() => executeSearch(query), 180);
  });

  // Tombol "+ Tambah" di samping input search
  document.getElementById('btn-add-search').addEventListener('click', () => {
    handleSearchEnter();
  });

  // Enter pada barcode input
  barcodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearchEnter();
    }
  });

  // Kosongkan keranjang
  document.getElementById('btn-clear-cart').addEventListener('click', () => {
    if (cart.length === 0) return;
    if (confirm('Kosongkan semua barang dari keranjang belanja?')) {
      clearCart();
    }
  });

  // Input uang bayar
  const paidInput = document.getElementById('input-paid-amount');
  paidInput.addEventListener('input', () => {
    calculateChange();
  });

  paidInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      processCheckout();
    }
  });

  // Tombol Uang Pas
  document.getElementById('btn-exact-cash').addEventListener('click', () => {
    const total = calculateGrandTotal();
    paidInput.value = total;
    calculateChange();
    document.getElementById('btn-checkout').focus();
  });

  // Pecahan Cepat (10rb, 20rb, 50rb, 100rb)
  document.querySelectorAll('.btn-quick-cash').forEach(btn => {
    btn.addEventListener('click', () => {
      const amount = Number(btn.dataset.amount) || 0;
      const current = Number(paidInput.value) || 0;
      paidInput.value = current + amount;
      calculateChange();
      paidInput.focus();
    });
  });

  // Metode Pembayaran (Tunai, QRIS, Transfer)
  document.querySelectorAll('.btn-pay-method').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-pay-method').forEach(b => {
        b.className = 'btn-pay-method px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium text-xs text-center';
      });
      btn.className = 'btn-pay-method px-3 py-2 rounded-lg border-2 border-emerald-600 bg-emerald-50 text-emerald-800 font-bold text-xs text-center';
      paymentMethod = btn.dataset.method;
      
      const labelMap = { cash: 'Tunai (Cash)', qris: 'QRIS', transfer: 'Transfer Bank' };
      document.getElementById('summary-payment-mode').textContent = labelMap[paymentMethod] || 'Tunai';

      // Jika bukan tunai, otomatis uang pas
      if (paymentMethod !== 'cash') {
        const total = calculateGrandTotal();
        paidInput.value = total;
      }
      calculateChange();
    });
  });

  // Tombol Checkout / Bayar
  document.getElementById('btn-checkout').addEventListener('click', () => {
    processCheckout();
  });

  // Modal Cetak & Transaksi Baru
  document.getElementById('btn-print-receipt').addEventListener('click', printReceipt);
  document.getElementById('btn-new-transaction').addEventListener('click', resetForNewTransaction);
  document.getElementById('btn-close-receipt').addEventListener('click', () => {
    document.getElementById('modal-receipt').classList.add('hidden');
    focusBarcodeInput();
  });

  // Modal Bantuan Pintasan
  document.getElementById('btn-shortcuts').addEventListener('click', openShortcutsModal);
  document.getElementById('btn-close-shortcuts').addEventListener('click', closeShortcutsModal);
  document.getElementById('btn-ack-shortcuts').addEventListener('click', closeShortcutsModal);

  // Modal Riwayat
  document.getElementById('btn-sales-history').addEventListener('click', openHistoryModal);
  document.getElementById('btn-close-history').addEventListener('click', closeHistoryModal);

  // Klik di luar dropdown untuk menutup dropdown
  document.addEventListener('click', (e) => {
    if (!barcodeInput.contains(e.target) && !searchDropdown.contains(e.target)) {
      searchDropdown.classList.add('hidden');
    }
  });
}

// ----------------------------------------------------
// LOGIKA CARI BARANG
// ----------------------------------------------------
async function executeSearch(query) {
  try {
    const res = await fetch(`/api/products/search?q=${encodeURIComponent(query)}`);
    const result = await res.json();
    if (!result.success || !result.data || result.data.length === 0) {
      searchDropdown.innerHTML = `<div class="p-3 text-xs text-slate-400 text-center">Barang "${query}" tidak ditemukan</div>`;
      searchDropdown.classList.remove('hidden');
      return;
    }

    searchDropdown.innerHTML = '';
    result.data.forEach(p => {
      const itemEl = document.createElement('div');
      itemEl.className = 'p-2.5 hover:bg-emerald-50 cursor-pointer flex items-center justify-between transition text-xs';
      itemEl.innerHTML = `
        <div>
          <span class="font-bold text-slate-800">${p.name}</span>
          <div class="text-[10px] text-slate-400">Barcode: ${p.barcode || '-'} | SKU: ${p.sku || '-'}</div>
        </div>
        <div class="text-right">
          <div class="font-bold text-emerald-700">${formatRupiah(p.selling_price)}</div>
          <div class="text-[10px] ${p.stock <= 5 ? 'text-rose-600 font-bold' : 'text-slate-500'}">Sisa: ${p.stock} ${p.unit}</div>
        </div>
      `;
      itemEl.addEventListener('click', () => {
        addToCart(p, 1);
        barcodeInput.value = '';
        searchDropdown.classList.add('hidden');
        focusBarcodeInput();
      });
      searchDropdown.appendChild(itemEl);
    });

    searchDropdown.classList.remove('hidden');
  } catch (err) {
    console.error('Error saat mencari barang:', err);
  }
}

async function handleSearchEnter() {
  const query = barcodeInput.value.trim();
  if (!query) return;

  try {
    const res = await fetch(`/api/products/search?q=${encodeURIComponent(query)}`);
    const result = await res.json();
    if (result.success && result.data && result.data.length > 0) {
      // Ambil produk pertama hasil pencarian
      const chosen = result.data[0];
      addToCart(chosen, 1);
      barcodeInput.value = '';
      searchDropdown.classList.add('hidden');
      focusBarcodeInput();
    } else {
      alert(`Barang dengan barcode/nama "${query}" tidak ditemukan!`);
    }
  } catch (err) {
    console.error('Error search enter:', err);
  }
}

function focusBarcodeInput() {
  if (barcodeInput) {
    barcodeInput.focus();
    barcodeInput.select();
  }
}

// ----------------------------------------------------
// MANAJEMEN KERANJANG BELANJA (CART)
// ----------------------------------------------------
function addToCart(product, quantity = 1) {
  const existingIndex = cart.findIndex(item => item.productId === product.id);

  if (existingIndex > -1) {
    const targetQty = cart[existingIndex].quantity + quantity;
    if (targetQty > product.stock) {
      alert(`Stok tidak mencukupi! Tersedia hanya ${product.stock} ${product.unit}.`);
      return;
    }
    cart[existingIndex].quantity = targetQty;
    cart[existingIndex].subtotal = cart[existingIndex].quantity * cart[existingIndex].price;
  } else {
    if (product.stock < quantity) {
      alert(`Stok tidak mencukupi! Tersedia hanya ${product.stock} ${product.unit}.`);
      return;
    }
    cart.push({
      productId: product.id,
      name: product.name,
      barcode: product.barcode,
      sku: product.sku,
      unit: product.unit || 'pcs',
      price: product.selling_price,
      costPrice: product.cost_price,
      stock: product.stock,
      quantity: quantity,
      subtotal: product.selling_price * quantity
    });
  }

  playScanSuccess();
  renderCart();
}

function updateCartQty(productId, newQty) {
  const item = cart.find(i => i.productId === productId);
  if (!item) return;

  const parsedQty = parseFloat(newQty);
  if (isNaN(parsedQty) || parsedQty <= 0) {
    removeFromCart(productId);
    return;
  }

  if (parsedQty > item.stock) {
    alert(`Stok tidak mencukupi! Maksimal ${item.stock} ${item.unit}.`);
    renderCart();
    return;
  }

  item.quantity = parsedQty;
  item.subtotal = item.quantity * item.price;
  renderCart();
}

function removeFromCart(productId) {
  cart = cart.filter(item => item.productId !== productId);
  renderCart();
}

function clearCart() {
  cart = [];
  document.getElementById('input-paid-amount').value = '';
  renderCart();
  focusBarcodeInput();
}

function calculateGrandTotal() {
  return cart.reduce((sum, item) => sum + item.subtotal, 0);
}

function renderCart() {
  const tbody = document.getElementById('cart-table-body');
  const emptyState = document.getElementById('cart-empty');
  const grandTotalEl = document.getElementById('display-grand-total');
  const itemCountEl = document.getElementById('cart-item-count');
  const totalQtyEl = document.getElementById('summary-total-qty');

  tbody.innerHTML = '';

  const grandTotal = calculateGrandTotal();
  const totalQty = cart.reduce((sum, item) => sum + item.quantity, 0);

  if (cart.length === 0) {
    emptyState.classList.remove('hidden');
    itemCountEl.textContent = '0 item';
    totalQtyEl.textContent = '0';
    grandTotalEl.textContent = 'Rp 0';
  } else {
    emptyState.classList.add('hidden');
    itemCountEl.textContent = `${cart.length} item`;
    totalQtyEl.textContent = `${totalQty}`;
    grandTotalEl.textContent = formatRupiah(grandTotal);

    cart.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50 transition border-b border-slate-100';

      tr.innerHTML = `
        <td class="py-2.5 px-3 text-center text-xs text-slate-400 font-mono">${index + 1}</td>
        <td class="py-2.5 px-3">
          <div class="font-bold text-slate-800 text-xs">${item.name}</div>
          <div class="text-[10px] text-slate-400 font-mono">${item.barcode || item.sku || '-'}</div>
        </td>
        <td class="py-2.5 px-3 text-right font-medium text-xs text-slate-600">
          ${formatRupiah(item.price)}
        </td>
        <td class="py-2.5 px-3">
          <div class="flex items-center justify-center space-x-1">
            <button type="button" class="btn-qty-minus w-6 h-6 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-bold text-xs flex items-center justify-center transition" data-id="${item.productId}">-</button>
            <input 
              type="number" 
              value="${item.quantity}" 
              min="0.1" 
              step="any"
              class="input-row-qty w-14 text-center py-1 px-1 border border-slate-300 rounded font-bold text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none" 
              data-id="${item.productId}"
            />
            <button type="button" class="btn-qty-plus w-6 h-6 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-bold text-xs flex items-center justify-center transition" data-id="${item.productId}">+</button>
            <span class="text-[10px] text-slate-400 w-6 text-left">${item.unit}</span>
          </div>
        </td>
        <td class="py-2.5 px-3 text-right font-bold text-xs text-emerald-700 font-mono">
          ${formatRupiah(item.subtotal)}
        </td>
        <td class="py-2.5 px-2 text-center">
          <button type="button" class="btn-remove-item text-slate-400 hover:text-rose-600 p-1 text-sm transition" data-id="${item.productId}" title="Hapus">
            ✕
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Attach event listeners untuk elemen tabel
    tbody.querySelectorAll('.btn-qty-minus').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const cur = cart.find(i => i.productId === id);
        if (cur) updateCartQty(id, cur.quantity - 1);
      });
    });

    tbody.querySelectorAll('.btn-qty-plus').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const cur = cart.find(i => i.productId === id);
        if (cur) updateCartQty(id, cur.quantity + 1);
      });
    });

    tbody.querySelectorAll('.input-row-qty').forEach(input => {
      input.addEventListener('change', () => {
        const id = Number(input.dataset.id);
        updateCartQty(id, input.value);
      });
    });

    tbody.querySelectorAll('.btn-remove-item').forEach(btn => {
      btn.addEventListener('click', () => {
        removeFromCart(Number(btn.dataset.id));
      });
    });
  }

  calculateChange();
}

// ----------------------------------------------------
// KALKULATOR KEMBALIAN OTOMATIS
// ----------------------------------------------------
function calculateChange() {
  const grandTotal = calculateGrandTotal();
  const paidInput = document.getElementById('input-paid-amount');
  const paidVal = parseFloat(paidInput.value) || 0;
  const changeEl = document.getElementById('display-change');
  const changeBox = document.getElementById('change-box');
  const changeStatus = document.getElementById('change-status');
  const btnCheckout = document.getElementById('btn-checkout');

  if (cart.length === 0) {
    changeEl.textContent = 'Rp 0';
    changeEl.className = 'text-2xl font-extrabold font-mono mt-1 text-slate-700';
    changeBox.className = 'p-4 rounded-xl border bg-slate-50 border-slate-200 transition-colors';
    changeStatus.textContent = 'Keranjang kosong';
    btnCheckout.disabled = true;
    btnCheckout.className = 'w-full py-4 px-6 bg-slate-300 text-slate-500 rounded-xl font-bold text-base shadow-sm transition flex items-center justify-center gap-2 cursor-not-allowed uppercase tracking-wide';
    return;
  }

  const change = paidVal - grandTotal;

  if (paidVal === 0) {
    changeEl.textContent = 'Rp 0';
    changeEl.className = 'text-2xl font-extrabold font-mono mt-1 text-slate-700';
    changeBox.className = 'p-4 rounded-xl border bg-slate-50 border-slate-200 transition-colors';
    changeStatus.textContent = 'Masukkan nominal bayar';
    btnCheckout.disabled = true;
    btnCheckout.className = 'w-full py-4 px-6 bg-slate-300 text-slate-500 rounded-xl font-bold text-base shadow-sm transition flex items-center justify-center gap-2 cursor-not-allowed uppercase tracking-wide';
  } else if (change >= 0) {
    // Uang Pas atau Ada Kembalian
    changeEl.textContent = formatRupiah(change);
    changeEl.className = 'text-2xl font-extrabold font-mono mt-1 text-emerald-800';
    changeBox.className = 'p-4 rounded-xl border bg-emerald-50 border-emerald-300 transition-colors';
    changeStatus.textContent = change === 0 ? '✅ Uang Pas' : '✅ Siap Bayar';
    changeStatus.className = 'text-[11px] font-bold text-emerald-700';

    btnCheckout.disabled = false;
    btnCheckout.className = 'w-full py-4 px-6 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-xl font-bold text-base shadow-lg shadow-emerald-600/30 transition transform active:scale-98 flex items-center justify-center gap-2 cursor-pointer uppercase tracking-wide animate-pulse';
  } else {
    // Uang Kurang
    changeEl.textContent = '-' + formatRupiah(Math.abs(change));
    changeEl.className = 'text-2xl font-extrabold font-mono mt-1 text-rose-700';
    changeBox.className = 'p-4 rounded-xl border bg-rose-50 border-rose-300 transition-colors';
    changeStatus.textContent = '❌ Kurang ' + formatRupiah(Math.abs(change));
    changeStatus.className = 'text-[11px] font-bold text-rose-600';

    btnCheckout.disabled = true;
    btnCheckout.className = 'w-full py-4 px-6 bg-rose-200 text-rose-600 rounded-xl font-bold text-base shadow-sm transition flex items-center justify-center gap-2 cursor-not-allowed uppercase tracking-wide';
  }
}

// ----------------------------------------------------
// PROSES CHECKOUT TRANSAKSI
// ----------------------------------------------------
async function processCheckout() {
  if (cart.length === 0) {
    alert('Keranjang belanja masih kosong!');
    focusBarcodeInput();
    return;
  }

  const grandTotal = calculateGrandTotal();
  const paidInput = document.getElementById('input-paid-amount');
  const paidVal = parseFloat(paidInput.value) || 0;

  if (paidVal < grandTotal) {
    alert(`Nominal pembayaran kurang! Total belanja: ${formatRupiah(grandTotal)}, Uang diterima: ${formatRupiah(paidVal)}.`);
    paidInput.focus();
    return;
  }

  const payload = {
    items: cart.map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      price: item.price,
      costPrice: item.costPrice,
      name: item.name,
      unit: item.unit
    })),
    paidAmount: paidVal,
    paymentMethod: paymentMethod,
    cashierName: 'Kasir Toko 1'
  };

  try {
    const btnCheckout = document.getElementById('btn-checkout');
    btnCheckout.disabled = true;
    btnCheckout.innerText = 'Menyimpan Transaksi...';

    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await res.json();

    if (!result.success) {
      alert('Gagal checkout: ' + result.message);
      btnCheckout.disabled = false;
      calculateChange();
      return;
    }

    // Berhasil: Mainkan audio, simpan transaksi, tampilkan struk
    playCheckoutSuccess();
    lastTransaction = result.data;
    showReceiptModal(result.data);
    clearCart();
    loadQuickProducts(); // refresh sisa stok produk cepat
  } catch (err) {
    console.error('Error saat checkout:', err);
    alert('Terjadi kesalahan jaringan atau server: ' + err.message);
  }
}

// ----------------------------------------------------
// STRUK & NOTA TRANSAKSI
// ----------------------------------------------------
function showReceiptModal(data) {
  document.getElementById('receipt-invoice').textContent = data.invoiceNumber;
  document.getElementById('receipt-date').textContent = new Date(data.createdAt).toLocaleString('id-ID');
  document.getElementById('receipt-cashier').textContent = data.cashierName;
  document.getElementById('receipt-total').textContent = formatRupiah(data.totalAmount);
  document.getElementById('receipt-paid').textContent = formatRupiah(data.paidAmount);
  document.getElementById('receipt-change').textContent = formatRupiah(data.changeAmount);
  document.getElementById('receipt-method').textContent = (data.paymentMethod || 'cash').toUpperCase();

  const tbody = document.getElementById('receipt-items-body');
  tbody.innerHTML = '';

  data.items.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="py-1">
        <div class="font-bold">${item.productName || item.name}</div>
        <div class="text-[10px] text-slate-500">${item.quantity} ${item.unit || ''} x ${formatRupiah(item.price)}</div>
      </td>
      <td class="py-1 text-right font-bold align-bottom">
        ${formatRupiah(item.subtotal)}
      </td>
    `;
    tbody.appendChild(tr);
  });

  const modal = document.getElementById('modal-receipt');
  modal.classList.remove('hidden');
  document.getElementById('btn-new-transaction').focus();
}

function printReceipt() {
  window.print();
}

function resetForNewTransaction() {
  document.getElementById('modal-receipt').classList.add('hidden');
  clearCart();
  focusBarcodeInput();
}

// ----------------------------------------------------
// PINTASAN KEYBOARD (HOTKEYS)
// ----------------------------------------------------
function setupKeyboardHotkeys() {
  window.addEventListener('keydown', (e) => {
    // F1: Bantuan Pintasan
    if (e.key === 'F1') {
      e.preventDefault();
      openShortcutsModal();
    }
    // F2: Fokus Pembayaran / Bayar
    else if (e.key === 'F2') {
      e.preventDefault();
      const paidInput = document.getElementById('input-paid-amount');
      const grandTotal = calculateGrandTotal();
      const paidVal = parseFloat(paidInput.value) || 0;

      if (cart.length > 0 && paidVal >= grandTotal && paidVal > 0) {
        processCheckout();
      } else {
        paidInput.focus();
        paidInput.select();
      }
    }
    // F4: Kosongkan Keranjang
    else if (e.key === 'F4') {
      e.preventDefault();
      if (cart.length > 0 && confirm('Kosongkan semua barang dari keranjang belanja?')) {
        clearCart();
      }
    }
    // F8: Fokus Input Barcode
    else if (e.key === 'F8') {
      e.preventDefault();
      focusBarcodeInput();
    }
    // F9: Riwayat Transaksi
    else if (e.key === 'F9') {
      e.preventDefault();
      openHistoryModal();
    }
    // Escape: Tutup Modal
    else if (e.key === 'Escape') {
      closeShortcutsModal();
      closeHistoryModal();
      document.getElementById('modal-receipt').classList.add('hidden');
      searchDropdown.classList.add('hidden');
      focusBarcodeInput();
    }
    // Enter di Modal Struk -> Transaksi Baru
    else if (e.key === 'Enter') {
      const receiptModal = document.getElementById('modal-receipt');
      if (!receiptModal.classList.contains('hidden')) {
        e.preventDefault();
        resetForNewTransaction();
      }
    }
  });
}

function openShortcutsModal() {
  document.getElementById('modal-shortcuts').classList.remove('hidden');
}

function closeShortcutsModal() {
  document.getElementById('modal-shortcuts').classList.add('hidden');
  focusBarcodeInput();
}

// ----------------------------------------------------
// RIWAYAT TRANSAKSI (F9)
// ----------------------------------------------------
async function openHistoryModal() {
  const modal = document.getElementById('modal-history');
  const tbody = document.getElementById('history-table-body');
  const loading = document.getElementById('history-loading');

  modal.classList.remove('hidden');
  tbody.innerHTML = '';
  loading.classList.remove('hidden');

  try {
    const res = await fetch('/api/sales?limit=25');
    const result = await res.json();
    loading.classList.add('hidden');

    if (!result.success || !result.data || result.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-slate-400">Belum ada transaksi hari ini</td></tr>';
      return;
    }

    result.data.forEach(sale => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50 transition border-b border-slate-100';
      tr.innerHTML = `
        <td class="py-2.5 px-3 font-mono font-bold text-slate-800">${sale.invoice_number}</td>
        <td class="py-2.5 px-3 text-slate-500">${new Date(sale.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</td>
        <td class="py-2.5 px-3 uppercase text-[10px] font-bold text-slate-600">${sale.payment_method}</td>
        <td class="py-2.5 px-3 text-right font-bold text-emerald-700">${formatRupiah(sale.total_amount)}</td>
        <td class="py-2.5 px-3 text-center">
          <button class="btn-view-invoice px-2 py-1 bg-slate-100 hover:bg-emerald-100 text-slate-700 hover:text-emerald-800 rounded text-[11px] font-semibold transition" data-id="${sale.id}">
            Lihat Struk
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-view-invoice').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        try {
          const detailRes = await fetch(`/api/sales/${id}`);
          const detail = await detailRes.json();
          if (detail.success) {
            closeHistoryModal();
            showReceiptModal({
              invoiceNumber: detail.data.invoice_number,
              createdAt: detail.data.created_at,
              cashierName: detail.data.cashier_name,
              totalAmount: detail.data.total_amount,
              paidAmount: detail.data.paid_amount,
              changeAmount: detail.data.change_amount,
              paymentMethod: detail.data.payment_method,
              items: detail.data.items
            });
          }
        } catch (e) {
          alert('Gagal mengambil data transaksi: ' + e.message);
        }
      });
    });
  } catch (err) {
    loading.textContent = 'Gagal memuat riwayat: ' + err.message;
  }
}

function closeHistoryModal() {
  document.getElementById('modal-history').classList.add('hidden');
  focusBarcodeInput();
}
