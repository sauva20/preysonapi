const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany();
  let updatedCount = 0;

  for (const product of products) {
    if (product.sizes) {
      try {
        const sizesArr = JSON.parse(product.sizes);
        // Check if it's already an array of objects
        if (sizesArr.length > 0 && typeof sizesArr[0] === 'string') {
          // It's an array of strings, we need to convert it
          // Distribute total stock roughly evenly across sizes for dummy data
          const totalStock = product.stock;
          const stockPerSize = Math.floor(totalStock / sizesArr.length);
          const remainder = totalStock % sizesArr.length;

          const newSizes = sizesArr.map((size, index) => ({
            name: size,
            stock: stockPerSize + (index === 0 ? remainder : 0) // Give remainder to the first size
          }));

          // Let's manually set one size to 0 stock for testing if there are at least 2 sizes
          if (newSizes.length > 1) {
             // Find a size to set to 0 stock
             // Add its stock back to the first item so total is preserved
             newSizes[0].stock += newSizes[newSizes.length - 1].stock;
             newSizes[newSizes.length - 1].stock = 0;
          }

          await prisma.product.update({
            where: { id: product.id },
            data: {
              sizes: JSON.stringify(newSizes)
            }
          });
          updatedCount++;
          console.log(`Updated product ${product.id} (${product.name}) sizes.`);
        }
      } catch (e) {
        console.error(`Error parsing sizes for product ${product.id}:`, e);
      }
    }
  }

  console.log(`Migration complete. Updated ${updatedCount} products.`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
