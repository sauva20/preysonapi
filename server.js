const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
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

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `http://localhost:5000/uploads/${req.file.filename}` });
});

// Helper to parse product JSON fields safely
const parseProduct = (p) => ({
  ...p,
  sizes: p.sizes ? JSON.parse(p.sizes) : [],
  thumbnails: p.thumbnails ? JSON.parse(p.thumbnails) : [],
  features: p.features ? JSON.parse(p.features) : [],
  materials: p.materials ? JSON.parse(p.materials) : [],
  washing: p.washing ? JSON.parse(p.washing) : []
});

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
    res.json(products.map(parseProduct));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { category: true }
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(parseProduct(product));
  } catch (error) { res.status(500).json({ error: 'Failed to fetch product' }); }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, sku, price, stock, image, categoryId, description, sizes, thumbnails, features, materials, washing, aestheticImage } = req.body;
    const product = await prisma.product.create({
      data: {
        name, sku, price: parseFloat(price), stock: parseInt(stock), image,
        categoryId: categoryId ? parseInt(categoryId) : null,
        description: description || '',
        aestheticImage: aestheticImage || null,
        sizes: sizes ? JSON.stringify(sizes) : '[]',
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
    const { name, sku, price, stock, image, categoryId, description, sizes, thumbnails, features, materials, washing, aestheticImage } = req.body;
    const product = await prisma.product.update({
      where: { id: parseInt(req.params.id) },
      data: {
        name, sku, price: parseFloat(price), stock: parseInt(stock), image,
        categoryId: categoryId ? parseInt(categoryId) : null,
        description: description || '',
        aestheticImage: aestheticImage || null,
        sizes: sizes ? JSON.stringify(sizes) : '[]',
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
              price: parseFloat(item.price)
            }))
          }
        },
        include: { items: { include: { product: true } }, customer: true }
      });
      
      for (const item of items) {
        await tx.product.update({
          where: { id: parseInt(item.productId) },
          data: { stock: { decrement: parseInt(item.quantity) }, sold: { increment: parseInt(item.quantity) } }
        });
      }
      return newOrder;
    });
    
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

// ==========================
// SETTINGS API
// ==========================
const settingsPath = path.join(__dirname, 'settings.json');

app.get('/api/settings', (req, res) => {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      res.json(JSON.parse(data));
    } else {
      res.json({});
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ success: true, settings: req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
// AUTH API
// ==========================

app.post('/api/auth/admin-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid admin credentials' });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
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

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
