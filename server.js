import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from './database/init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let db = null;

// Helper: Format Rupiah
function formatRupiah(amount) {
  return 'Rp ' + Number(amount).toLocaleString('id-ID');
}

// ----------------------------------------------------
// 1. API PRODUK & PENCARIAN
// ----------------------------------------------------

// GET /api/products - Ambil semua barang atau cari via query ?q=
app.get('/api/products', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const lowStockOnly = req.query.low_stock === 'true';

    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (q) {
      query += ' AND (barcode LIKE ? OR sku LIKE ? OR name LIKE ?)';
      const searchParam = `%${q}%`;
      params.push(searchParam, searchParam, searchParam);
    }

    if (lowStockOnly) {
      query += ' AND stock <= 5';
    }

    query += ' ORDER BY name ASC';
    const products = db.prepare(query).all(...params);
    res.json({ success: true, data: products });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ success: false, message: 'Gagal mengambil data produk: ' + error.message });
  }
});

// GET /api/products/search - Pencarian instan kasir (prioritas exact barcode)
app.get('/api/products/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({ success: true, data: [] });
    }

    // 1. Cek kecocokan tepat (exact match) barcode atau SKU terlebih dahulu
    const exact = db.prepare('SELECT * FROM products WHERE barcode = ? OR sku = ? LIMIT 1').get(q, q);
    if (exact) {
      return res.json({ success: true, exact: true, data: [exact] });
    }

    // 2. Jika tidak ada exact, cari berdasarkan substring nama, barcode, atau SKU
    const searchPattern = `%${q}%`;
    const results = db.prepare(`
      SELECT * FROM products 
      WHERE name LIKE ? OR barcode LIKE ? OR sku LIKE ? 
      ORDER BY 
        CASE WHEN name LIKE ? THEN 1 ELSE 2 END,
        name ASC 
      LIMIT 15
    `).all(searchPattern, searchPattern, searchPattern, `${q}%`);

    res.json({ success: true, exact: false, data: results });
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ success: false, message: 'Gagal mencari barang: ' + error.message });
  }
});

// GET /api/products/:id - Ambil detail 1 produk
app.get('/api/products/:id', (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Barang tidak ditemukan' });
    }
    res.json({ success: true, data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/products - Tambah barang baru
app.post('/api/products', (req, res) => {
  try {
    const { barcode, sku, name, cost_price, selling_price, stock, unit } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Nama barang wajib diisi' });
    }

    const cleanBarcode = barcode && barcode.trim() !== '' ? barcode.trim() : null;
    const cleanSku = sku && sku.trim() !== '' ? sku.trim() : null;

    // Cek duplikasi barcode jika diisi
    if (cleanBarcode) {
      const existingBarcode = db.prepare('SELECT id FROM products WHERE barcode = ?').get(cleanBarcode);
      if (existingBarcode) {
        return res.status(400).json({ success: false, message: `Barcode "${cleanBarcode}" sudah digunakan oleh barang lain.` });
      }
    }

    // Cek duplikasi SKU jika diisi
    if (cleanSku) {
      const existingSku = db.prepare('SELECT id FROM products WHERE sku = ?').get(cleanSku);
      if (existingSku) {
        return res.status(400).json({ success: false, message: `SKU "${cleanSku}" sudah digunakan.` });
      }
    }

    const stmt = db.prepare(`
      INSERT INTO products (barcode, sku, name, cost_price, selling_price, stock, unit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      cleanBarcode,
      cleanSku,
      name.trim(),
      parseFloat(cost_price) || 0,
      parseFloat(selling_price) || 0,
      parseFloat(stock) || 0,
      (unit && unit.trim()) || 'pcs'
    );

    const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, message: 'Barang berhasil ditambahkan', data: newProduct });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ success: false, message: 'Gagal menambah barang: ' + error.message });
  }
});

// PUT /api/products/:id - Ubah data barang
app.put('/api/products/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { barcode, sku, name, cost_price, selling_price, stock, unit } = req.body;

    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Barang tidak ditemukan' });
    }

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Nama barang wajib diisi' });
    }

    const cleanBarcode = barcode && barcode.trim() !== '' ? barcode.trim() : null;
    const cleanSku = sku && sku.trim() !== '' ? sku.trim() : null;

    if (cleanBarcode) {
      const dup = db.prepare('SELECT id FROM products WHERE barcode = ? AND id != ?').get(cleanBarcode, id);
      if (dup) {
        return res.status(400).json({ success: false, message: `Barcode "${cleanBarcode}" sudah digunakan oleh barang lain.` });
      }
    }

    if (cleanSku) {
      const dupSku = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(cleanSku, id);
      if (dupSku) {
        return res.status(400).json({ success: false, message: `SKU "${cleanSku}" sudah digunakan.` });
      }
    }

    const stmt = db.prepare(`
      UPDATE products 
      SET barcode = ?, sku = ?, name = ?, cost_price = ?, selling_price = ?, stock = ?, unit = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(
      cleanBarcode,
      cleanSku,
      name.trim(),
      parseFloat(cost_price) || 0,
      parseFloat(selling_price) || 0,
      parseFloat(stock) || 0,
      (unit && unit.trim()) || 'pcs',
      id
    );

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.json({ success: true, message: 'Data barang berhasil diperbarui', data: updated });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ success: false, message: 'Gagal memperbarui barang: ' + error.message });
  }
});

// PATCH /api/products/:id/stock - Tambah / kurangi stok cepat (Kulakan)
app.patch('/api/products/:id/stock', (req, res) => {
  try {
    const { id } = req.params;
    const { adjustment, new_stock } = req.body;

    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Barang tidak ditemukan' });
    }

    let finalStock = existing.stock;
    if (new_stock !== undefined) {
      finalStock = Math.max(0, parseFloat(new_stock) || 0);
    } else if (adjustment !== undefined) {
      finalStock = Math.max(0, existing.stock + (parseFloat(adjustment) || 0));
    }

    db.prepare('UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(finalStock, id);
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(id);

    res.json({ success: true, message: 'Stok berhasil diperbarui', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/products/:id - Hapus barang
app.delete('/api/products/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Barang tidak ditemukan' });
    }

    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ success: true, message: `Barang "${existing.name}" berhasil dihapus` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ----------------------------------------------------
// 2. CHECKOUT TRANSAKSI (DENGAN db.transaction())
// ----------------------------------------------------

app.post('/api/checkout', (req, res) => {
  try {
    const { items, paidAmount, paymentMethod = 'cash', cashierName = 'Kasir Toko' } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Keranjang belanja kosong' });
    }

    const paid = parseFloat(paidAmount) || 0;

    // Eksekusi transaksi atomik SQLite:
    // Jika stok tidak cukup atau terjadi error, semua query otomatis di-rollback
    const executeCheckout = db.transaction(() => {
      let totalAmount = 0;
      const verifiedItems = [];

      // 1. Verifikasi ketersediaan dan validitas stok barang
      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        if (!product) {
          throw new Error(`Barang ID ${item.productId} tidak ditemukan di database.`);
        }

        const qty = parseFloat(item.quantity) || 1;
        if (qty <= 0) {
          throw new Error(`Jumlah untuk ${product.name} harus lebih besar dari 0.`);
        }

        if (product.stock < qty) {
          throw new Error(`Stok "${product.name}" tidak mencukupi! Tersedia: ${product.stock} ${product.unit}, diminta: ${qty} ${product.unit}.`);
        }

        const itemPrice = parseFloat(item.price) !== undefined ? parseFloat(item.price) : product.selling_price;
        const subtotal = itemPrice * qty;
        totalAmount += subtotal;

        verifiedItems.push({
          product,
          productId: product.id,
          productName: product.name,
          costPrice: product.cost_price,
          price: itemPrice,
          quantity: qty,
          unit: product.unit,
          subtotal: subtotal
        });
      }

      if (paid < totalAmount) {
        throw new Error(`Nominal pembayaran (${formatRupiah(paid)}) kurang dari total belanja (${formatRupiah(totalAmount)}).`);
      }

      const changeAmount = paid - totalAmount;

      // 2. Generate nomor faktur/invoice unik: INV-YYYYMMDD-HHMMSS-XXX
      const now = new Date();
      const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
      const timePart = now.toTimeString().slice(0, 8).replace(/:/g, '');
      const randomPart = Math.floor(100 + Math.random() * 900);
      const invoiceNumber = `INV-${datePart}-${timePart}-${randomPart}`;

      // 3. Simpan data header penjualan (sales)
      const saleResult = db.prepare(`
        INSERT INTO sales (invoice_number, total_amount, paid_amount, change_amount, payment_method, cashier_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(invoiceNumber, totalAmount, paid, changeAmount, paymentMethod, cashierName);

      const saleId = saleResult.lastInsertRowid;

      // 4. Simpan setiap item penjualan dan kurangi stok barang secara otomatis
      const insertItemStmt = db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_name, price, cost_price, quantity, subtotal)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const updateStockStmt = db.prepare(`
        UPDATE products 
        SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `);

      for (const item of verifiedItems) {
        insertItemStmt.run(
          saleId,
          item.productId,
          item.productName,
          item.price,
          item.costPrice,
          item.quantity,
          item.subtotal
        );

        updateStockStmt.run(item.quantity, item.productId);
      }

      return {
        saleId,
        invoiceNumber,
        totalAmount,
        paidAmount: paid,
        changeAmount,
        paymentMethod,
        cashierName,
        createdAt: now.toISOString(),
        items: verifiedItems
      };
    });

    const receipt = executeCheckout();

    res.json({
      success: true,
      message: 'Transaksi berhasil disimpan dan stok terpotong otomatis.',
      data: receipt
    });
  } catch (error) {
    console.error('Error during checkout:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});

// ----------------------------------------------------
// 3. RIWAYAT TRANSAKSI & LAPORAN
// ----------------------------------------------------

// GET /api/sales - Daftar transaksi terbaru
app.get('/api/sales', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const sales = db.prepare(`
      SELECT * FROM sales 
      ORDER BY id DESC 
      LIMIT ?
    `).all(limit);

    res.json({ success: true, data: sales });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/sales/:id - Detail transaksi beserta item
app.get('/api/sales/:id', (req, res) => {
  try {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ? OR invoice_number = ?').get(req.params.id, req.params.id);
    if (!sale) {
      return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
    }

    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
    res.json({ success: true, data: { ...sale, items } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/summary - Ringkasan kasir & stok toko
app.get('/api/summary', (req, res) => {
  try {
    // Total omzet hari ini
    const today = new Date().toISOString().slice(0, 10);
    const todaySales = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
      FROM sales 
      WHERE DATE(created_at) = DATE('now')
    `).get();

    // Total jenis produk & stok menipis
    const productStats = db.prepare(`
      SELECT 
        COUNT(*) as total_products,
        SUM(CASE WHEN stock <= 5 THEN 1 ELSE 0 END) as low_stock_count,
        SUM(stock * selling_price) as inventory_value
      FROM products
    `).get();

    res.json({
      success: true,
      data: {
        todayTotal: todaySales?.total || 0,
        todayTransactions: todaySales?.count || 0,
        totalProducts: productStats?.total_products || 0,
        lowStockCount: productStats?.low_stock_count || 0,
        inventoryValue: productStats?.inventory_value || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Fallback untuk SPA / file statis
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Mulai inisialisasi server
async function startServer() {
  try {
    db = await getDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`=================================================`);
      console.log(` POS Kasir & Stok Toko Kelontong Berjalan!`);
      console.log(` Akses Kasir : http://localhost:${PORT}`);
      console.log(` Kelola Stok : http://localhost:${PORT}/barang.html`);
      console.log(`=================================================`);
    });
  } catch (err) {
    console.error('Fatal: Gagal memulai server:', err);
    process.exit(1);
  }
}

startServer();
