const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Clearing database...');
  try {
    // Need to delete OrderItems first because of foreign key constraint
    await prisma.orderItem.deleteMany({});
    console.log('Deleted all OrderItems.');
    
    await prisma.order.deleteMany({});
    console.log('Deleted all Orders.');

    const deletedProducts = await prisma.product.deleteMany({});
    console.log(`Successfully deleted ${deletedProducts.count} products.`);
    
  } catch (error) {
    console.error('Error clearing database:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
