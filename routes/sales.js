const express = require("express");
const router = express.Router();
const db = require("../db");
const verifyToken = require("../middleware/auth");


// ======================================================
// 📊 GET SALES
// ======================================================
router.get("/", verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.*, p.name AS product_name
       FROM sales s
       JOIN products p ON s.product_id = p.id
       WHERE s.shop_id = $1
       ORDER BY s.created_at DESC`,
      [req.user.shop_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Erreur GET /sales:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// ➕ CREATE SALE (transaction sécurisée)
// ======================================================
router.post("/", verifyToken, async (req, res) => {
  const { product_id, quantity, payment_method, client_name, client_phone, due_date } = req.body;

  if (!product_id || !quantity || quantity <= 0) {
    return res.status(400).json({ error: "Données invalides" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `SELECT price, stock 
       FROM products 
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [product_id, req.user.shop_id]
    );

    const product = productResult.rows[0];

    if (!product) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Produit introuvable" });
    }

    if (product.stock < quantity) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Stock insuffisant" });
    }

    const total = product.price * quantity;
    const paid = payment_method === "credit" ? false : true;

    const saleResult = await client.query(
      `INSERT INTO sales
       (product_id, quantity, total, payment_method, user_id, shop_id, 
        client_name, client_phone, due_date, paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        product_id,
        quantity,
        total,
        payment_method,
        req.user.id,
        req.user.shop_id,
        client_name || null,
        client_phone || null,
        due_date || null,
        paid
      ]
    );

    await client.query(
      `UPDATE products 
       SET stock = stock - $1 
       WHERE id = $2 AND shop_id = $3`,
      [quantity, product_id, req.user.shop_id]
    );

    await client.query("COMMIT");

    res.status(201).json(saleResult.rows[0]);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur POST /sales:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});


// ======================================================
// ✏️ UPDATE SALE
// ======================================================
router.patch("/:id", verifyToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { quantity, payment_method, paid, repayment_method } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const saleResult = await client.query(
      `SELECT * FROM sales 
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [id, req.user.shop_id]
    );

    if (saleResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Vente introuvable" });
    }

    const sale = saleResult.rows[0];

    if (quantity !== undefined && quantity > 0 && quantity !== sale.quantity) {
      const productResult = await client.query(
        `SELECT price, stock 
         FROM products 
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [sale.product_id, req.user.shop_id]
      );

      const product = productResult.rows[0];

      const diff = quantity - sale.quantity;

      if (diff > 0 && product.stock < diff) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Stock insuffisant" });
      }

      await client.query(
        `UPDATE sales 
         SET quantity = $1,
             total = $2,
             payment_method = COALESCE($3, payment_method),
             paid = COALESCE($4, paid),
             repayment_method = COALESCE($5, repayment_method)
         WHERE id = $6 AND shop_id = $7`,
        [
          quantity,
          product.price * quantity,
          payment_method,
          paid,
          repayment_method,
          id,
          req.user.shop_id
        ]
      );

      await client.query(
        `UPDATE products 
         SET stock = stock - $1
         WHERE id = $2 AND shop_id = $3`,
        [diff, sale.product_id, req.user.shop_id]
      );
    } else {
      await client.query(
        `UPDATE sales
         SET payment_method = COALESCE($1, payment_method),
             paid = COALESCE($2, paid),
             repayment_method = COALESCE($3, repayment_method)
         WHERE id = $4 AND shop_id = $5`,
        [payment_method, paid, repayment_method, id, req.user.shop_id]
      );
    }

    await client.query("COMMIT");

    const updated = await db.query(
      `SELECT * FROM sales 
       WHERE id = $1 AND shop_id = $2`,
      [id, req.user.shop_id]
    );

    res.json(updated.rows[0]);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur PATCH /sales:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});


// ======================================================
// ❌ DELETE SALE (remet stock)
// ======================================================
router.delete("/:id", verifyToken, async (req, res) => {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const saleResult = await client.query(
      `SELECT * FROM sales 
       WHERE id = $1 AND shop_id = $2`,
      [req.params.id, req.user.shop_id]
    );

    if (saleResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Vente introuvable" });
    }

    const sale = saleResult.rows[0];

    // 🔄 Remettre stock
    await client.query(
      `UPDATE products 
       SET stock = stock + $1 
       WHERE id = $2 AND shop_id = $3`,
      [sale.quantity, sale.product_id, req.user.shop_id]
    );

    await client.query(
      `DELETE FROM sales 
       WHERE id = $1 AND shop_id = $2`,
      [req.params.id, req.user.shop_id]
    );

    await client.query("COMMIT");

    res.json({ message: "Vente annulée et stock restauré" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur DELETE /sales:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

module.exports = router;
