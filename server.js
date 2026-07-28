const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const midtransClient = require('midtrans-client');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'preyson_jwt_secret_key_2026';

// Global crash handlers to prevent Node process from dying on database disconnects / Hostinger timeouts
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL SERVER ERROR] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL SERVER ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.set('io', null);

// listen will be called at the bottom

const prisma = new PrismaClient();

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
}));

app.use(express.json());

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Fallback: Hanya redirect jika dijalankan di localhost lokal (mencegah ERR_TOO_MANY_REDIRECTS di Hostinger)
app.use('/uploads/:filename', (req, res, next) => {
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  if (isLocal) {
    const remoteUrl = `https://api.preysonmoto.com/uploads/${req.params.filename}`;
    return res.redirect(remoteUrl);
  }
  return res.status(404).send('File not found');
});

// Auto-migrate missing columns in production MySQL if needed
async function autoMigrate() {
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE \`product\` ADD COLUMN \`isSoldOut\` TINYINT(1) NOT NULL DEFAULT 0;`);
    console.log('[AUTO-MIGRATE] Added isSoldOut column to product table.');
  } catch (err) {
    // Column already exists, safe to ignore
  }
}
autoMigrate();

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${baseUrl}/uploads/${req.file.filename}` });
});

// Helper to parse JSON fields safely without crashing
const safeParse = (str, fallback) => {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.error('Invalid JSON in DB:', str);
    return fallback;
  }
};

// Helper to format upload URLs dynamically based on current server environment
const formatImageUrl = (url, req) => {
  if (!url || typeof url !== 'string') return url;
  if (url.includes('/uploads/')) {
    const filename = url.split('/uploads/').pop();
    const baseUrl = process.env.BASE_URL || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:5000');
    return `${baseUrl}/uploads/${filename}`;
  }
  return url;
};

const slugify = (text) => {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
};

const parseProduct = (p, req) => {
  const rawThumbnails = safeParse(p.thumbnails, []);
  const formattedThumbnails = Array.isArray(rawThumbnails)
    ? rawThumbnails.map(t => formatImageUrl(t, req))
    : rawThumbnails;

  return {
    ...p,
    slug: p.slug || slugify(p.name),
    image: formatImageUrl(p.image, req),
    aestheticImage: formatImageUrl(p.aestheticImage, req),
    sizes: safeParse(p.sizes, []),
    sizeGuide: safeParse(p.sizeGuide, null),
    thumbnails: formattedThumbnails,
    features: safeParse(p.features, []),
    materials: safeParse(p.materials, []),
    washing: safeParse(p.washing, [])
  };
};


// ==========================
// DASHBOARD API
// ==========================
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { period } = req.query;
    let dateFilter = {};

    if (period && period !== 'all') {
      const now = new Date();
      let startDate = new Date();
      if (period === 'today') {
        startDate.setHours(0, 0, 0, 0);
      } else if (period === 'week') {
        startDate.setDate(now.getDate() - 7);
      } else if (period === 'month') {
        startDate.setMonth(now.getMonth() - 1);
      }
      dateFilter = { date: { gte: startDate } };
    }

    const totalOrders = await prisma.order.count({ where: dateFilter });
    const totalSalesAggr = await prisma.order.aggregate({ 
      where: dateFilter, 
      _sum: { total: true } 
    });
    const totalSales = totalSalesAggr._sum.total || 0;
    const totalCustomers = await prisma.user.count({ where: { role: 'customer' } });
    const lowStockProducts = await prisma.product.count({ where: { stock: { lt: 5 } } });
    
    res.json({ totalOrders, totalSales, totalCustomers, lowStockProducts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// PRODUCTS API
// ==========================
app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({ include: { category: true } });
    res.json(products.map(p => parseProduct(p, req)));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const param = req.params.id;
    let product = null;

    if (!isNaN(param)) {
      product = await prisma.product.findUnique({
        where: { id: parseInt(param) },
        include: { category: true }
      });
    }

    if (!product) {
      const allProducts = await prisma.product.findMany({ include: { category: true } });
      product = allProducts.find(p => p.slug === param || slugify(p.name) === param || String(p.id) === param);
    }

    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(parseProduct(product, req));
  } catch (error) { res.status(500).json({ error: 'Failed to fetch product' }); }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, sku, price, stock, image, categoryId, description, sizes, sizeGuide, thumbnails, features, materials, washing, aestheticImage, isSoldOut } = req.body;
    const product = await prisma.product.create({
      data: {
        name, sku, price: parseFloat(price), stock: parseInt(stock), image,
        isSoldOut: isSoldOut ? Boolean(isSoldOut) : false,
        categoryId: categoryId ? parseInt(categoryId) : null,
        description: description || '',
        aestheticImage: aestheticImage || null,
        sizes: sizes ? JSON.stringify(sizes) : '[]',
        sizeGuide: sizeGuide ? JSON.stringify(sizeGuide) : null,
        thumbnails: thumbnails ? JSON.stringify(thumbnails) : '[]',
        features: features ? JSON.stringify(features) : '[]',
        materials: materials ? JSON.stringify(materials) : '[]',
        washing: washing ? JSON.stringify(washing) : '[]'
      },
      include: { category: true }
    });
    res.json(parseProduct(product));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { name, sku, price, stock, image, categoryId, description, sizes, sizeGuide, thumbnails, features, materials, washing, aestheticImage, isSoldOut } = req.body;
    const product = await prisma.product.update({
      where: { id: parseInt(req.params.id) },
      data: {
        name, sku, price: parseFloat(price), stock: parseInt(stock), image,
        isSoldOut: isSoldOut !== undefined ? Boolean(isSoldOut) : undefined,
        categoryId: categoryId ? parseInt(categoryId) : null,
        description: description || '',
        aestheticImage: aestheticImage || null,
        sizes: sizes ? JSON.stringify(sizes) : '[]',
        sizeGuide: sizeGuide ? JSON.stringify(sizeGuide) : null,
        thumbnails: thumbnails ? JSON.stringify(thumbnails) : '[]',
        features: features ? JSON.stringify(features) : '[]',
        materials: materials ? JSON.stringify(materials) : '[]',
        washing: washing ? JSON.stringify(washing) : '[]'
      },
      include: { category: true }
    });
    const _io = app.get('io');
    if (_io) _io.emit('stock_updated');
    res.json(parseProduct(product));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/products/:id/toggle-soldout', async (req, res) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    
    const updated = await prisma.product.update({
      where: { id: parseInt(req.params.id) },
      data: { isSoldOut: !existing.isSoldOut },
      include: { category: true }
    });
    const _io = app.get('io');
    if (_io) _io.emit('stock_updated');
    res.json(parseProduct(updated));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    // Delete order items referencing this product first (or cascade in prisma)
    await prisma.orderItem.deleteMany({ where: { productId: parseInt(req.params.id) } });
    await prisma.product.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================
// CATEGORIES API
// ==========================
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await prisma.category.findMany();
    res.json(categories);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/categories', async (req, res) => {
  try {
    const cat = await prisma.category.create({ data: { name: req.body.name, image: req.body.image } });
    res.json(cat);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/categories/:id', async (req, res) => {
  try {
    await prisma.product.updateMany({ where: { categoryId: parseInt(req.params.id) }, data: { categoryId: null } });
    await prisma.category.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================
// ORDERS API
// ==========================
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: { items: { include: { product: true } }, customer: true },
      orderBy: { date: 'desc' }
    });
    res.json(orders);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const nodemailer = require('nodemailer');

app.post('/api/orders', async (req, res) => {
  try {
    const { customerId, customerName, customerEmail, items, paymentMethod, subtotal, tax, total, source } = req.body;
    
    let finalCustomerId = customerId ? parseInt(customerId) : null;
    
    // Auto-create or find user if customerEmail is provided
    if (!finalCustomerId && customerEmail) {
      let user = await prisma.user.findUnique({ where: { email: customerEmail } });
      if (!user) {
        const hashedPassword = await bcrypt.hash("preyson123", 10);
        user = await prisma.user.create({
          data: {
            name: customerName || 'Guest Customer',
            email: customerEmail,
            password: hashedPassword,
            role: 'customer'
          }
        });
      }
      finalCustomerId = user.id;
    }

    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          customerId: finalCustomerId,
          source: source || 'POS',
          paymentMethod: paymentMethod || 'Cash', 
          subtotal: parseFloat(subtotal), 
          tax: parseFloat(tax), 
          total: parseFloat(total),
          items: {
            create: items.map(item => ({
              productId: parseInt(item.productId),
              quantity: parseInt(item.quantity),
              price: parseFloat(item.price),
              size: item.size || null
            }))
          }
        },
        include: { items: { include: { product: true } }, customer: true }
      });
      
      for (const item of items) {
        const prod = await tx.product.findUnique({ where: { id: parseInt(item.productId) } });
        if (prod) {
          let updatedSizesStr = prod.sizes;
          if (prod.sizes && item.size) {
            try {
              let sizesObj = JSON.parse(prod.sizes);
              if (Array.isArray(sizesObj)) {
                sizesObj = sizesObj.map(s => {
                  const sName = typeof s === 'string' ? s : (s.name || s.size);
                  if (sName === item.size) {
                    if (typeof s === 'object') {
                      const curStk = typeof s.stock === 'number' ? s.stock : parseInt(s.stock || 0);
                      return { ...s, stock: Math.max(0, curStk - parseInt(item.quantity)) };
                    }
                  }
                  return s;
                });
                updatedSizesStr = JSON.stringify(sizesObj);
              }
            } catch (e) {
              console.error('Error updating size stock in POST /api/orders:', e);
            }
          }

          await tx.product.update({
            where: { id: parseInt(item.productId) },
            data: {
              stock: Math.max(0, prod.stock - parseInt(item.quantity)),
              sold: (prod.sold || 0) + parseInt(item.quantity),
              sizes: updatedSizesStr
            }
          });
        }
      }
      return newOrder;
    });
    
    const _io = app.get('io');
    if (_io) _io.emit('stock_updated');
    
    // Send email receipt if email is provided
    if (customerEmail) {
      try {
        let testAccount = await nodemailer.createTestAccount();
        let transporter = nodemailer.createTransport({
          host: "smtp.ethereal.email",
          port: 587,
          secure: false, 
          auth: {
            user: testAccount.user, 
            pass: testAccount.pass, 
          },
        });

        let itemListHtml = order.items.map(i => `<li>${i.quantity}x ${i.product.name} - $${i.price}</li>`).join('');
        
        let info = await transporter.sendMail({
          from: '"Preyson POS" <noreply@preyson.com>',
          to: customerEmail,
          subject: `Receipt for Order #${order.id.split('-')[0]}`,
          html: `
            <h2>Thank you for your purchase!</h2>
            <p>Hi ${customerName || 'Customer'},</p>
            <p>Here is your receipt from Preyson:</p>
            <ul>${itemListHtml}</ul>
            <p><strong>Subtotal:</strong> $${order.subtotal}</p>
            <p><strong>Tax:</strong> $${order.tax}</p>
            <p><strong>Total:</strong> $${order.total}</p>
          `
        });
        
        console.log("Receipt sent! Preview URL: %s", nodemailer.getTestMessageUrl(info));
      } catch (emailErr) {
        console.error("Failed to send email receipt:", emailErr);
      }
    }

    res.json(order);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/orders/:id', async (req, res) => {
  try {
    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: req.body.status }
    });
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Removed file-based settings API

// ==========================
// CUSTOMERS API
// ==========================
app.get('/api/customers', async (req, res) => {
  try {
    const customers = await prisma.user.findMany({
      where: { role: 'customer' },
      include: { orders: true }
    });
    res.json(customers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================
// CAMPAIGNS API
// ==========================
app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany();
    res.json(campaigns);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/campaigns', async (req, res) => {
  try {
    const campaign = await prisma.campaign.create({ 
      data: { 
        code: req.body.code,
        discountPct: parseFloat(req.body.discountPct), 
        startDate: new Date(req.body.startDate), 
        endDate: new Date(req.body.endDate) 
      } 
    });
    res.json(campaign);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    await prisma.campaign.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================
// STAFF API
// ==========================

app.get('/api/staff', async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: { role: { not: 'customer' } },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true }
    });
    res.json(staff);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const staff = await prisma.user.create({
      data: { name, email, password: hashedPassword, role, status: 'ACTIVE' }
    });
    res.json({ id: staff.id, name: staff.name, email: staff.email, role: staff.role, status: staff.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', async (req, res) => {
  const { role, status } = req.body;
  try {
    const updated = await prisma.user.update({
      where: { id: parseInt(req.params.id) },
      data: { role, status }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================
// AUTH API
// ==========================

app.post('/api/auth/admin-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.role === 'customer') {
      return res.status(401).json({ error: 'Invalid credentials or unauthorized role' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid admin credentials' });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ message: 'Login successful', token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/customer-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.role !== 'customer') {
      return res.status(401).json({ error: 'Invalid credentials or you are not a customer' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required' });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword, role: 'customer' }
    });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Registration successful', token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    res.json({ message: 'If that email is in our database, we have sent a password reset link.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================
// CHECKOUT API
// ==========================

// 1. Validate Voucher
app.post('/api/checkout/validate-voucher', async (req, res) => {
  const { code } = req.body;
  try {
    const campaign = await prisma.campaign.findUnique({ where: { code } });
    if (!campaign) return res.status(404).json({ error: 'Voucher not found' });
    if (campaign.status !== 'Active') return res.status(400).json({ error: 'Voucher inactive' });
    if (new Date() > new Date(campaign.endDate)) return res.status(400).json({ error: 'Voucher expired' });
    
    res.json({ discountPct: campaign.discountPct });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 1.5 Search Area (Biteship)
app.get('/api/checkout/search-area', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.json({ areas: [] });

  try {
    const bitesKeySetting = await prisma.setting.findUnique({ where: { key: 'biteship_api_key' }});
    const BITES_KEY = bitesKeySetting ? bitesKeySetting.value : '';
    
    if (!BITES_KEY || BITES_KEY === 'dummy_biteship_key' || BITES_KEY === '') {
      const q = query.toLowerCase();
      const mockAreas = [
        { id: 'area_1', name: 'Kebayoran Baru', administrative_division_level_2_name: 'Jakarta Selatan', administrative_division_level_1_name: 'DKI Jakarta', postal_code: 12110 },
        { id: 'area_2', name: 'Kebayoran Lama', administrative_division_level_2_name: 'Jakarta Selatan', administrative_division_level_1_name: 'DKI Jakarta', postal_code: 12240 },
        { id: 'area_3', name: 'Pagaden', administrative_division_level_2_name: 'Subang', administrative_division_level_1_name: 'Jawa Barat', postal_code: 41252 },
        { id: 'area_4', name: 'Pagaden Barat', administrative_division_level_2_name: 'Subang', administrative_division_level_1_name: 'Jawa Barat', postal_code: 41253 },
        { id: 'area_5', name: 'Bandung Wetan', administrative_division_level_2_name: 'Bandung', administrative_division_level_1_name: 'Jawa Barat', postal_code: 40115 },
        { id: 'area_6', name: 'Buahbatu', administrative_division_level_2_name: 'Bandung', administrative_division_level_1_name: 'Jawa Barat', postal_code: 40286 },
        { id: 'area_7', name: 'Buahdua', administrative_division_level_2_name: 'Sumedang', administrative_division_level_1_name: 'Jawa Barat', postal_code: 45392 }
      ];
      const filtered = mockAreas.filter(a => a.name.toLowerCase().includes(q) || a.administrative_division_level_2_name.toLowerCase().includes(q));
      return res.json({ areas: filtered });
    }

    const response = await axios.get(`https://api.biteship.com/v1/maps/areas?countries=ID&input=${encodeURIComponent(query)}&type=single`, {
      headers: { 'authorization': `Bearer ${BITES_KEY}` }
    });

    if (response.data && response.data.areas) {
      res.json({ areas: response.data.areas });
    } else {
      res.json({ areas: [] });
    }
  } catch(e) {
    console.error("Biteship Area Search error:", e.message);
    res.json({ areas: [] });
  }
});

// 2. Biteship Rates
app.post('/api/checkout/shipping-rates', async (req, res) => {
  const { destinationAreaId, destinationPostal } = req.body;
  try {
    const bitesKeySetting = await prisma.setting.findUnique({ where: { key: 'biteship_api_key' }});
    const BITES_KEY = bitesKeySetting ? bitesKeySetting.value : '';
    
    if (!BITES_KEY || BITES_KEY === 'dummy_biteship_key' || BITES_KEY === '') {
      return res.json({
        rates: [
          { courier: 'JNE', service: 'REG', price: 15000, etd: '2-3 days' },
          { courier: 'Sicepat', service: 'BEST', price: 20000, etd: '1-2 days' }
        ]
      });
    }

    const postalSetting = await prisma.setting.findUnique({ where: { key: 'store_postal_code' }});
    const areaSetting = await prisma.setting.findUnique({ where: { key: 'store_area_id' }});
    const originPostal = postalSetting ? postalSetting.value : '40115';
    const originAreaId = areaSetting ? areaSetting.value : null;
    
    // We prioritize area_id if provided, otherwise fallback to postal_code
    const payload = {
      couriers: "jne,sicepat,jnt,anteraja,tiki,pos,ninja,lion,idexpress,gosend,grab",
      items: [
        {
          name: "Apparel",
          description: "Preyson product",
          value: 150000,
          weight: 500
        }
      ]
    };

    if (originAreaId) {
      payload.origin_area_id = originAreaId;
    } else {
      payload.origin_postal_code = parseInt(originPostal);
    }

    if (destinationAreaId) {
      payload.destination_area_id = destinationAreaId;
    } else {
      payload.destination_postal_code = parseInt(destinationPostal);
    }
    
    const response = await axios.post('https://api.biteship.com/v1/rates/couriers', payload, {
      headers: {
        'authorization': `Bearer ${BITES_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.pricing) {
      const formattedRates = response.data.pricing.map(p => ({
        courier: p.company,
        service: p.type,
        price: p.price,
        etd: p.estimated_delivery || 'N/A'
      }));
      res.json({ rates: formattedRates });
    } else {
      res.json({ rates: [] });
    }
  } catch(e) {
    console.error("Biteship error:", e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to fetch rates from Biteship' });
  }
});

// 3. Process Checkout (Create Order & Midtrans Token)
app.post('/api/checkout/process', async (req, res) => {
  console.log("Received checkout request:", req.body);
  const {
    customerName, customerEmail, customerPhone,
    shippingAddress, shippingCity, shippingProvince, shippingPostal, shippingCourier, shippingCost,
    discount, voucherCode, subtotal, tax, total, items, customerId
  } = req.body;

  try {
    // 1. Verify and deduct stock
    for (const item of items) {
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product) return res.status(400).json({ error: `Product ${item.productId} not found` });
      
      let sizesObj = [];
      try { sizesObj = JSON.parse(product.sizes); } catch (e) {}
      
      let sizeIdx = -1;
      let sizeStock = 999;
      if (item.size) {
        sizeIdx = sizesObj.findIndex(s => (typeof s === 'string' ? s : s.name) === item.size);
        if (sizeIdx > -1) {
          const sObj = sizesObj[sizeIdx];
          sizeStock = typeof sObj === 'string' ? 999 : (sObj.stock || 0);
        } else {
          return res.status(400).json({ error: `Size ${item.size} not found for ${product.name}` });
        }
      } else {
        sizeStock = product.stock; // global fallback
      }

      if (item.quantity > sizeStock || item.quantity > product.stock) {
        return res.status(400).json({ error: `Insufficient stock for ${product.name} (Size: ${item.size || 'N/A'})` });
      }
      
      // Deduct stock
      let newSizes = [...sizesObj];
      if (sizeIdx > -1 && typeof newSizes[sizeIdx] !== 'string') {
        newSizes[sizeIdx].stock -= item.quantity;
      }
      
      await prisma.product.update({
        where: { id: product.id },
        data: {
          stock: product.stock - item.quantity,
          sizes: JSON.stringify(newSizes)
        }
      });
    }

    const _io = app.get('io');
    if (_io) _io.emit('stock_updated');

    const serverKeySetting = await prisma.setting.findUnique({ where: { key: 'midtrans_server_key' }});
    const clientKeySetting = await prisma.setting.findUnique({ where: { key: 'midtrans_client_key' }});
    const isProdSetting = await prisma.setting.findUnique({ where: { key: 'midtrans_is_production' }});
    
    const isProduction = isProdSetting ? isProdSetting.value === 'true' : false;
    const serverKey = serverKeySetting ? serverKeySetting.value : '';
    const clientKey = clientKeySetting ? clientKeySetting.value : '';

    const customOrderId = 'PRY-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    const order = await prisma.order.create({
      data: {
        id: customOrderId,
        customerName, customerEmail, customerPhone, customerId,
        shippingAddress, shippingCity, shippingProvince, shippingPostal: String(shippingPostal), shippingCourier, shippingCost,
        discount, voucherCode, subtotal, tax, total,
        paymentMethod: 'Midtrans',
        expiresAt,
        items: {
          create: items.map(item => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price,
            size: item.size || null
          }))
        }
      }
    });

    if (serverKey && serverKey !== 'dummy_server_key') {
      const snap = new midtransClient.Snap({
        isProduction,
        serverKey,
        clientKey
      });
      const parameter = {
        transaction_details: {
          order_id: order.id,
          gross_amount: Math.round(total)
        },
        customer_details: {
          first_name: customerName,
          email: customerEmail,
          phone: customerPhone,
        }
      };
      
      const transaction = await snap.createTransaction(parameter);
      
      await prisma.order.update({
        where: { id: order.id },
        data: { midtransToken: transaction.token }
      });
      
      res.json({ orderId: order.id, token: transaction.token });
    } else {
      res.json({ orderId: order.id, token: 'dummy_token' });
    }
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to process checkout' });
  }
});

// ==========================
// ORDERS API
// ==========================
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: { product: true }
        }
      }
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/orders/:id/payment-status', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id }
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({
      status: order.status,
      midtransToken: order.midtransToken,
      expiresAt: order.expiresAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper function to restore stock
const restoreOrderStock = async (orderId) => {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true }
  });
  if (!order || order.status !== 'Pending') return;

  for (const item of order.items) {
    const product = await prisma.product.findUnique({ where: { id: item.productId } });
    if (!product) continue;
    
    let sizesObj = [];
    try { sizesObj = JSON.parse(product.sizes); } catch (e) {}
    
    let newSizes = [...sizesObj];
    if (item.size) {
      const sizeIdx = newSizes.findIndex(s => (typeof s === 'string' ? s : s.name) === item.size);
      if (sizeIdx > -1 && typeof newSizes[sizeIdx] !== 'string') {
        newSizes[sizeIdx].stock += item.quantity;
      }
    }

    await prisma.product.update({
      where: { id: product.id },
      data: {
        stock: product.stock + item.quantity,
        sizes: JSON.stringify(newSizes)
      }
    });
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'Expired' }
  });
  
  const _io = app.get('io');
    if (_io) _io.emit('stock_updated');
};

app.post('/api/orders/:id/cancel', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || order.status !== 'Pending') {
      return res.status(400).json({ error: 'Cannot cancel this order' });
    }
    await restoreOrderStock(order.id);
    res.json({ success: true, message: 'Order expired and stock restored' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Background cron: Check for expired orders every 1 minute
setInterval(async () => {
  try {
    const expiredOrders = await prisma.order.findMany({
      where: {
        status: 'Pending',
        expiresAt: { lt: new Date() }
      }
    });
    for (const order of expiredOrders) {
      console.log(`Auto-expiring order ${order.id}...`);
      await restoreOrderStock(order.id);
    }
  } catch (e) {
    console.error("Cron Error: Failed to expire orders", e);
  }
}, 60 * 1000);


app.post('/api/orders/:id/ship', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const bitesKeySetting = await prisma.setting.findUnique({ where: { key: 'biteship_api_key' }});
    const BITES_KEY = bitesKeySetting ? bitesKeySetting.value : '';
    
    if (!BITES_KEY || BITES_KEY === 'dummy_biteship_key') {
      return res.status(400).json({ error: 'Biteship API Key is not configured' });
    }

    const postalSetting = await prisma.setting.findUnique({ where: { key: 'store_postal_code' }});
    const originPostal = postalSetting ? postalSetting.value : '40115';

    // Call Biteship Create Order API
    const payload = {
      origin_contact_name: "Preyson Admin",
      origin_contact_phone: "081234567890",
      origin_address: "Preyson Moto Company Store",
      origin_postal_code: parseInt(originPostal),
      destination_contact_name: order.customerName,
      destination_contact_phone: order.customerPhone,
      destination_address: order.shippingAddress,
      destination_postal_code: parseInt(order.shippingPostal),
      courier_company: order.shippingCourier.toLowerCase(),
      courier_type: "reg",
      delivery_type: "now",
      items: [
        {
          name: "Preyson Apparel",
          value: order.subtotal,
          weight: 500
        }
      ]
    };

    const biteshipRes = await axios.post('https://api.biteship.com/v1/orders', payload, {
      headers: { authorization: BITES_KEY, 'content-type': 'application/json' }
    });

    const trackingCode = biteshipRes.data.courier.waybill_id;
    const biteshipOrderId = biteshipRes.data.id;

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { trackingCode, biteshipOrderId, status: 'Shipped' }
    });

    res.json(updatedOrder);
  } catch (error) {
    console.error("Biteship shipment error:", error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create shipment with Biteship' });
  }
});

// ==========================
// BITESHIP REAL-TIME TRACKING API
// ==========================
app.get('/api/tracking/:waybill', async (req, res) => {
  try {
    const { waybill } = req.params;
    const courier = (req.query.courier || 'jne').toLowerCase();

    const keySetting = await prisma.setting.findUnique({ where: { key: 'biteship_api_key' } });
    const apiKey = keySetting ? keySetting.value : process.env.BITESHIP_API_KEY;

    if (apiKey && apiKey.trim() !== '') {
      try {
        const response = await axios.get(
          `https://api.biteship.com/v1/trackings/${waybill}/courier/${courier}`,
          {
            headers: {
              'Authorization': apiKey,
              'Content-Type': 'application/json'
            }
          }
        );
        if (response.data && response.data.history) {
          return res.json(response.data);
        }
      } catch (apiErr) {
        console.warn("Biteship API call failed or key invalid, serving simulation checkpoints:", apiErr.message);
      }
    }

    const now = new Date();
    const yesterday = new Date(now.getTime() - 20 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 44 * 60 * 60 * 1000);

    const mockTracking = {
      success: true,
      message: "Tracking data retrieved successfully",
      courier: {
        company: courier.toUpperCase(),
        driver_name: "Ahmad Rizky (Courier Driver)",
        driver_phone: "0812-9876-5432"
      },
      waybill_id: waybill,
      status: "in_transit",
      history: [
        {
          note: `Paket sedang dalam perjalanan via kurir ${courier.toUpperCase()} menuju kota tujuan (In Transit via Hub Main Center)`,
          updated_at: now.toISOString(),
          status: "in_transit",
          location: "Central Sorting Hub"
        },
        {
          note: `Paket telah dijemput kurir ${courier.toUpperCase()} dari gudang pengirim`,
          updated_at: yesterday.toISOString(),
          status: "picked_up",
          location: "Preyson Warehouse, Subang"
        },
        {
          note: "Pesanan telah diproses dan nomor resi pengiriman dibuat",
          updated_at: twoDaysAgo.toISOString(),
          status: "allocated",
          location: "Preyson Store, Subang"
        }
      ]
    };

    res.json(mockTracking);
  } catch (error) {
    console.error("Tracking error:", error);
    res.status(500).json({ error: "Failed to retrieve package tracking information" });
  }
});

// ==========================
// SETTINGS API
// ==========================
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await prisma.setting.findMany();
    const config = {};
    settings.forEach(s => { config[s.key] = s.value; });
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/settings', async (req, res) => {
  const settingsObj = req.body;
  try {
    for (const [key, value] of Object.entries(settingsObj)) {
      await prisma.setting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) }
      });
    }
    res.json({ message: 'Settings saved successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Checkout config (public keys)
app.get('/api/checkout/config', async (req, res) => {
  try {
    const clientKeySetting = await prisma.setting.findUnique({ where: { key: 'midtrans_client_key' }});
    const isProdSetting = await prisma.setting.findUnique({ where: { key: 'midtrans_is_production' }});
    res.json({
      clientKey: clientKeySetting ? clientKeySetting.value : '',
      isProduction: isProdSetting ? isProdSetting.value === 'true' : false
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================
// CUSTOMER AUTH & OTP API
// ==========================
const otpStore = new Map();

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const cleanEmail = email.trim().toLowerCase();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    otpStore.set(cleanEmail, {
      code: otpCode,
      expiresAt,
      verified: false
    });

    console.log(`[AUTH OTP SENT] Email: ${cleanEmail} | OTP Code: ${otpCode}`);

    res.json({
      success: true,
      message: `OTP Code sent to ${cleanEmail}`,
      otp: otpCode
    });
  } catch (error) {
    console.error("Send OTP Error:", error);
    res.status(500).json({ error: 'Failed to send OTP code' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP code are required' });

    const cleanEmail = email.trim().toLowerCase();
    const stored = otpStore.get(cleanEmail);

    if (!stored) {
      return res.status(400).json({ error: 'No active OTP request found for this email. Please request a new OTP.' });
    }

    if (Date.now() > stored.expiresAt) {
      otpStore.delete(cleanEmail);
      return res.status(400).json({ error: 'OTP code has expired. Please request a new one.' });
    }

    if (stored.code !== String(otp).trim()) {
      return res.status(400).json({ error: 'Invalid OTP code. Please check and try again.' });
    }

    stored.verified = true;
    res.json({ success: true, message: 'OTP verified successfully' });
  } catch (error) {
    console.error("Verify OTP Error:", error);
    res.status(500).json({ error: 'Failed to verify OTP code' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ error: 'Email and new password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const stored = otpStore.get(cleanEmail);

    if (otp) {
      if (!stored || stored.code !== String(otp).trim()) {
        return res.status(400).json({ error: 'Invalid or expired OTP code' });
      }
    } else if (!stored || !stored.verified) {
      return res.status(400).json({ error: 'OTP verification required before changing password' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const user = await prisma.user.findFirst({ where: { email: cleanEmail } });
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword }
      });
    }

    otpStore.delete(cleanEmail);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error("Reset Password Error:", error);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// ==========================
// ACTIVITY LOG API
// ==========================
const ACTIVITIES_FILE = path.join(__dirname, 'activitylogs.json');

const getActivities = () => {
  if (fs.existsSync(ACTIVITIES_FILE)) {
    try {
      const data = fs.readFileSync(ACTIVITIES_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      console.error('Error reading activities file:', e);
    }
  }
  return [];
};

const saveActivities = (activities) => {
  try {
    fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify(activities, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving activities file:', e);
  }
};

app.get('/api/activities', (req, res) => {
  try {
    const activities = getActivities();
    res.json(activities);
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

app.post('/api/activities', (req, res) => {
  try {
    const { category, title, description, user, status, timestamp } = req.body;
    const newActivity = {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      timestamp: timestamp || new Date().toISOString(),
      category: category || 'Sistem',
      title: title || 'Aktivitas Admin',
      description: description || '',
      user: user || 'Administrator',
      status: status || 'info'
    };

    const current = getActivities();
    const updated = [newActivity, ...current].slice(0, 500);
    saveActivities(updated);

    const io = req.app.get('io');
    if (io) {
      io.emit('activity_added', newActivity);
    }

    res.json(newActivity);
  } catch (error) {
    console.error('Error creating activity log:', error);
    res.status(500).json({ error: 'Failed to save activity log' });
  }
});

app.delete('/api/activities', (req, res) => {
  try {
    saveActivities([]);
    const io = req.app.get('io');
    if (io) {
      io.emit('activities_cleared');
    }
    res.json({ message: 'Activities cleared successfully' });
  } catch (error) {
    console.error('Error clearing activities:', error);
    res.status(500).json({ error: 'Failed to clear activities' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Catch-All JSON 404 Handler for API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  next();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
