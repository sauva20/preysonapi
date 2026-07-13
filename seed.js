const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@preyson.com' },
    update: {},
    create: {
      email: 'admin@preyson.com',
      password: hashedPassword,
      name: 'Super Admin',
      role: 'admin',
    },
  });
  console.log('Admin account created or already exists:', admin.email);

  // Seed Categories
  const catTees = await prisma.category.upsert({
    where: { name: 'Tees' },
    update: {},
    create: { name: 'Tees', image: '/images/cat_tees.png' }
  });

  const catGloves = await prisma.category.upsert({
    where: { name: 'Gloves' },
    update: {},
    create: { name: 'Gloves', image: '/images/cat_gloves.png' }
  });

  // Seed Products
  const dummyProducts = [
    {
      name: 'PREYSON SIGNATURE',
      sku: 'PRY-SIG-001',
      price: 150000,
      image: '/images/cat_tees.png',
      categoryId: catTees.id,
      stock: 100,
      description: 'Signature apparel from Preyson Moto.',
      sizes: '["S", "M", "L", "XL"]',
      thumbnails: '["/images/cat_tees.png"]',
      features: '["Premium Cotton", "Breathable", "Preyson Logo"]',
      materials: '["100% Cotton"]',
      washing: '["Machine wash cold", "Tumble dry low"]'
    },
    {
      name: 'PREYSON GLOVES',
      sku: 'PRY-GLV-001',
      price: 250000,
      image: '/images/cat_gloves.png',
      categoryId: catGloves.id,
      stock: 50,
      description: 'High quality leather gloves for riding.',
      sizes: '["M", "L", "XL"]',
      thumbnails: '["/images/cat_gloves.png"]',
      features: '["Genuine Leather", "Knuckle Protection", "Touchscreen Compatible"]',
      materials: '["Cowhide Leather"]',
      washing: '["Leather cleaner only"]'
    },
    {
      name: 'KANYU',
      sku: 'PRY-KNY-001',
      price: 888000,
      image: '/images/hero_bg.png', // Fallback to hero bg which has bike
      categoryId: catTees.id,
      stock: 10,
      description: 'Limited edition Kanyu series.',
      sizes: '["All Size"]',
      thumbnails: '["/images/hero_bg.png"]',
      features: '["Limited Edition", "Special Design"]',
      materials: '["Premium Material"]',
      washing: '["Hand wash recommended"]'
    }
  ];

  for (const prod of dummyProducts) {
    await prisma.product.upsert({
      where: { sku: prod.sku },
      update: {},
      create: prod
    });
  }
  console.log('Categories and Products seeded.');
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
