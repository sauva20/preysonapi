const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf8');

const parseFn = `const parseProduct = (p) => {
  const safeParse = (str, fallback) => {
    try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; }
  };
  return {
    ...p,
    sizes: safeParse(p.sizes, []),
    sizeGuide: safeParse(p.sizeGuide, null),
    thumbnails: safeParse(p.thumbnails, []),
    features: safeParse(p.features, []),
    materials: safeParse(p.materials, []),
    washing: safeParse(p.washing, [])
  };
};

`;

if (!content.includes('const parseProduct')) {
  content = content.replace('// PRODUCTS API', parseFn + '// PRODUCTS API');
}

// GET /api/products
content = content.replace(
  "    res.json(products);\n  } catch (error) {\n    res.status(500).json({ error: 'Failed to fetch products'",
  "    res.json(products.map(parseProduct));\n  } catch (error) {\n    res.status(500).json({ error: 'Failed to fetch products'"
);

// GET /api/products/:id
content = content.replace(
  "    if (!product) return res.status(404).json({ error: 'Product not found' });\n    res.json(parseProduct(product, req));",
  "    if (!product) return res.status(404).json({ error: 'Product not found' });\n    res.json(parseProduct(product));"
);
content = content.replace( // if it was not parseProduct(product, req) yet
  "    if (!product) return res.status(404).json({ error: 'Product not found' });\n    res.json(product);",
  "    if (!product) return res.status(404).json({ error: 'Product not found' });\n    res.json(parseProduct(product));"
);

// POST /api/products
content = content.replace(
  "      include: { category: true }\n    });\n    res.json(product);\n  } catch (error) { res.status(500).json({ error: error.message }); }\n});\n\napp.put('/api/products/:id'",
  "      include: { category: true }\n    });\n    res.json(parseProduct(product));\n  } catch (error) { res.status(500).json({ error: error.message }); }\n});\n\napp.put('/api/products/:id'"
);

// PUT /api/products/:id
content = content.replace(
  "      include: { category: true }\n    });\n    res.json(updated);\n  } catch (error) { res.status(500).json({ error: error.message }); }\n});\n\napp.delete('/api/products/:id'",
  "      include: { category: true }\n    });\n    res.json(parseProduct(updated));\n  } catch (error) { res.status(500).json({ error: error.message }); }\n});\n\napp.delete('/api/products/:id'"
);

fs.writeFileSync('server.js', content);
console.log('Fixed server.js');
