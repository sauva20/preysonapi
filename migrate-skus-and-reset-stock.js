const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function migrate() {
  console.log('Starting SKU migration and stock reset...');
  try {
    const products = await prisma.product.findMany();
    console.log(`Found ${products.length} products to update.`);

    for (const product of products) {
      let sizes = [];
      try {
        sizes = JSON.parse(product.sizes);
      } catch (e) {
        console.warn(`Could not parse sizes for product ${product.id} (${product.name}), skipping sizes update.`);
      }

      if (Array.isArray(sizes)) {
        sizes = sizes.map(s => {
          let sizeObj = typeof s === 'string' ? { name: s, stock: 0 } : s;
          sizeObj.stock = 0; // reset stock to 0
          
          if (!sizeObj.sku) {
            // Generate SKU: [CategoryPrefix]-[ProductPrefix]-[Size]-[Random]
            // We'll use a simplified version for migration
            const prodPrefix = product.name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase();
            const sizePrefix = sizeObj.name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
            const random = Math.floor(1000 + Math.random() * 9000);
            sizeObj.sku = `PRD-${prodPrefix}-${sizePrefix}-${random}`;
          }
          return sizeObj;
        });
      }

      await prisma.product.update({
        where: { id: product.id },
        data: {
          stock: 0,
          eventStock: 0,
          sizes: JSON.stringify(sizes)
        }
      });
      console.log(`Updated product ID ${product.id}: ${product.name}`);
    }

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
