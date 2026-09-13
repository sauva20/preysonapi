const { PrismaClient } = require('./prisma/generated/client');
const prisma = new PrismaClient();
async function main() {
  try {
    const p = await prisma.product.findFirst();
    console.log("SUCCESS! Connected to DB and found product:", p ? p.name : "none");
  } catch (e) {
    console.error("ERROR:", e);
  } finally {
    await prisma.$disconnect();
  }
}
main();
