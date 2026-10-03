import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFilePath = path.join(__dirname, 'pos_kelontong.db');

let dbInstance = null;

/**
 * Inisialisasi Database SQLite
 * Mendukung native 'better-sqlite3', dan menyediakan fallback otomatis jika modul native belum terpasang.
 */
export async function getDatabase() {
  if (dbInstance) return dbInstance;

  try {
    // 1. Coba gunakan better-sqlite3 jika tersedia di environment
    const DatabaseModule = await import('better-sqlite3');
    const Database = DatabaseModule.default || DatabaseModule;
    const db = new Database(dbFilePath);
    db.pragma('journal_mode = WAL');
    setupSchema(db);
    seedInitialData(db);
    dbInstance = db;
    console.log('[SQLite] Terhubung menggunakan better-sqlite3:', dbFilePath);
    return db;
  } catch (err) {
    console.warn('[SQLite] better-sqlite3 tidak tersedia atau butuh kompilasi native, beralih ke engine sql.js:', err.message);
    
    // 2. Fallback aman menggunakan sql.js yang kompatibel 100%
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    
    let fileBuffer = null;
    if (fs.existsSync(dbFilePath)) {
      fileBuffer = fs.readFileSync(dbFilePath);
    }
    const rawDb = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

    // Fungsi simpan otomatis ke file disk
    const persistToFile = () => {
      try {
        const data = rawDb.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbFilePath, buffer);
      } catch (saveErr) {
        console.error('[SQLite] Gagal menyimpan ke file:', saveErr);
      }
    };

    // Wrapper agar memiliki interface yang identik dengan better-sqlite3
    const compatDb = {
      pragma: (cmd) => {
        try { rawDb.run(`PRAGMA ${cmd};`); } catch (e) {}
      },
      exec: (sql) => {
        rawDb.run(sql);
        persistToFile();
      },
      prepare: (sql) => {
        return {
          run: (...params) => {
            const normalizedParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
              ? Object.values(params[0])
              : params.flat();
            rawDb.run(sql, normalizedParams);
            persistToFile();
            
            // Dapatkan lastInsertRowid & changes
            let lastId = 0;
            let changes = 1;
            try {
              const res = rawDb.exec('SELECT last_insert_rowid() AS id, changes() AS ch');
              if (res[0] && res[0].values[0]) {
                lastId = res[0].values[0][0];
                changes = res[0].values[0][1];
              }
            } catch (e) {}
            return { lastInsertRowid: lastId, changes: changes };
          },
          get: (...params) => {
            const normalizedParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
              ? Object.values(params[0])
              : params.flat();
            const stmt = rawDb.prepare(sql);
            stmt.bind(normalizedParams);
            let row = null;
            if (stmt.step()) {
              row = stmt.getAsObject();
            }
            stmt.free();
            return row;
          },
          all: (...params) => {
            const normalizedParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
              ? Object.values(params[0])
              : params.flat();
            const stmt = rawDb.prepare(sql);
            stmt.bind(normalizedParams);
            const rows = [];
            while (stmt.step()) {
              rows.push(stmt.getAsObject());
            }
            stmt.free();
            return rows;
          }
        };
      },
      transaction: (fn) => {
        return (...args) => {
          rawDb.run('BEGIN TRANSACTION;');
          try {
            const result = fn(...args);
            rawDb.run('COMMIT;');
            persistToFile();
            return result;
          } catch (error) {
            rawDb.run('ROLLBACK;');
            persistToFile();
            throw error;
          }
        };
      }
    };

    setupSchema(compatDb);
    seedInitialData(compatDb);
    dbInstance = compatDb;
    console.log('[SQLite] Database siap dengan fallback sql.js:', dbFilePath);
    return compatDb;
  }
}

/**
 * Buat skema tabel & index untuk produk, penjualan, dan item penjualan
 */
function setupSchema(db) {
  // 1. Tabel Produk
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT UNIQUE,
      sku TEXT UNIQUE,
      name TEXT NOT NULL,
      cost_price REAL NOT NULL DEFAULT 0,
      selling_price REAL NOT NULL DEFAULT 0,
      stock REAL NOT NULL DEFAULT 0,
      unit TEXT DEFAULT 'pcs',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Indexing untuk pencarian cepat barcode dan nama barang
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
  `);

  // 2. Tabel Sales (Penjualan / Transaksi)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT UNIQUE NOT NULL,
      total_amount REAL NOT NULL,
      paid_amount REAL NOT NULL,
      change_amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'cash',
      cashier_name TEXT DEFAULT 'Kasir Toko',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
  `);

  // 3. Tabel Sale Items (Detail Barang dalam Transaksi)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      price REAL NOT NULL,
      cost_price REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL,
      subtotal REAL NOT NULL,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);
  `);
}

/**
 * Isi data awal (seed) produk sembako jika tabel masih kosong
 */
function seedInitialData(db) {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM products').get();
  if (countRow && countRow.count > 0) {
    return;
  }

  console.log('[SQLite] Mengisi data produk awal toko sembako...');
  const insertStmt = db.prepare(`
    INSERT INTO products (barcode, sku, name, cost_price, selling_price, stock, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const initialProducts = [
    ['8991001', 'BRS-01', 'Beras Rojolele Super 5kg', 65000, 72000, 25, 'sak'],
    ['8991002', 'MYK-01', 'Minyak Goreng Bimoli 2 Liter', 32000, 36000, 40, 'pouch'],
    ['8991003', 'GUL-01', 'Gula Pasir Gulaku Putih 1kg', 14500, 17500, 35, 'kg'],
    ['8991004', 'MIE-01', 'Indomie Goreng Spesial', 2800, 3500, 150, 'bungkus'],
    ['8991005', 'TLR-01', 'Telur Ayam Negeri Segar 1kg', 26000, 29000, 30, 'kg'],
    ['8991006', 'KPI-01', 'Kopi Kapal Api Special Mix 1 Renceng', 12000, 15000, 50, 'renceng'],
    ['8991007', 'TEH-01', 'Teh Celup SariWangi Kotak isi 25', 5500, 7500, 45, 'kotak'],
    ['8991008', 'SBN-01', 'Sabun Mandi Lifebuoy Total 10 110g', 3800, 5000, 60, 'pcs'],
    ['8991009', 'AQUA-01', 'Air Mineral Aqua Botol 600ml', 3000, 4500, 72, 'botol'],
    ['8991010', 'TPG-01', 'Tepung Terigu Segitiga Biru 1kg', 11000, 13500, 28, 'kg'],
    ['8991011', 'SUSU-01', 'Susu Kental Manis Frisian Flag Cokelat', 10500, 13000, 40, 'kaleng'],
    ['8991012', 'MIE-02', 'Indomie Kuah Ayam Bawang', 2800, 3500, 100, 'bungkus']
  ];

  for (const prod of initialProducts) {
    insertStmt.run(prod[0], prod[1], prod[2], prod[3], prod[4], prod[5], prod[6]);
  }

  console.log('[SQLite] Sukses menginput data awal produk!');
}
