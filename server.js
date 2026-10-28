require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { getSupabase } = require("./supabase");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "..", "frontend")));

function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return res.status(503).json({ error: "Admin access is not configured. Set ADMIN_KEY in backend/.env." });
  const provided = req.get("x-admin-key") || "";
  if (provided.length !== expected.length || !safeEqual(provided, expected)) return res.status(401).json({ error: "Invalid admin key." });
  next();
}
function safeEqual(a, b) {
  const crypto = require("crypto");
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cleanText(value, max) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function validateFaq(body) {
  const question = cleanText(body.question, 240);
  const answer = cleanText(body.answer, 5000);
  const category = cleanText(body.category, 60);
  if (question.length < 5 || answer.length < 2 || category.length < 2) return { error: "Question (at least 5 characters), answer, and category (at least 2 characters) are required." };
  return { value: { question, answer, category } };
}
function dbError(res, error, action = "Database request failed") {
  console.error(action + ":", error.message);
  return res.status(500).json({ error: action + ". Check the database schema and connection settings." });
}

app.get("/api/health", (req, res) => res.json({ status: "ok", service: "FAQ Help Center API" }));

app.get("/api/faqs", asyncRoute(async (req, res) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("faqs").select("id, question, answer, category, created_at, updated_at").order("category").order("created_at", { ascending: false });
  if (error) return dbError(res, error, "Could not load FAQs");
  res.json({ faqs: data });
}));

app.post("/api/support", asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 254).toLowerCase();
  const subject = cleanText(req.body.subject, 120);
  const message = cleanText(req.body.message, 2000);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || subject.length < 3 || message.length < 10) {
    return res.status(400).json({ error: "Enter a valid name, email, subject, and a question of at least 10 characters." });
  }
  const { data, error } = await getSupabase().from("support_requests").insert({ name, email, subject, message }).select("id, status, created_at").single();
  if (error) return dbError(res, error, "Could not save support request");
  res.status(201).json({ message: "Support request submitted", request: data });
}));

app.get("/api/admin/faqs", requireAdmin, asyncRoute(async (req, res) => {
  const { data, error } = await getSupabase().from("faqs").select("*").order("created_at", { ascending: false });
  if (error) return dbError(res, error, "Could not load FAQs");
  res.json({ faqs: data });
}));
app.post("/api/admin/faqs", requireAdmin, asyncRoute(async (req, res) => {
  const checked = validateFaq(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { data, error } = await getSupabase().from("faqs").insert(checked.value).select().single();
  if (error) return dbError(res, error, "Could not create FAQ");
  res.status(201).json({ faq: data });
}));
app.put("/api/admin/faqs/:id", requireAdmin, asyncRoute(async (req, res) => {
  const checked = validateFaq(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { data, error } = await getSupabase().from("faqs").update({ ...checked.value, updated_at: new Date().toISOString() }).eq("id", req.params.id).select().maybeSingle();
  if (error) return dbError(res, error, "Could not update FAQ");
  if (!data) return res.status(404).json({ error: "FAQ not found." });
  res.json({ faq: data });
}));
app.delete("/api/admin/faqs/:id", requireAdmin, asyncRoute(async (req, res) => {
  const { data, error } = await getSupabase().from("faqs").delete().eq("id", req.params.id).select("id").maybeSingle();
  if (error) return dbError(res, error, "Could not delete FAQ");
  if (!data) return res.status(404).json({ error: "FAQ not found." });
  res.json({ message: "FAQ deleted" });
}));
app.get("/api/admin/support", requireAdmin, asyncRoute(async (req, res) => {
  const { data, error } = await getSupabase().from("support_requests").select("*").order("created_at", { ascending: false });
  if (error) return dbError(res, error, "Could not load support requests");
  res.json({ requests: data });
}));
app.patch("/api/admin/support/:id", requireAdmin, asyncRoute(async (req, res) => {
  const status = cleanText(req.body.status, 20);
  if (!["open", "resolved"].includes(status)) return res.status(400).json({ error: "Status must be open or resolved." });
  const { data, error } = await getSupabase().from("support_requests").update({ status }).eq("id", req.params.id).select("id, status").maybeSingle();
  if (error) return dbError(res, error, "Could not update support request");
  if (!data) return res.status(404).json({ error: "Support request not found." });
  res.json({ request: data });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use((err, req, res, next) => {
  console.error("Request error:", err.message);
  if (res.headersSent) return next(err);
  const status = err.status || (err.type === "entity.parse.failed" ? 400 : 500);
  res.status(status).json({ error: status === 400 ? "Invalid JSON request." : (status < 500 ? err.message : "Unexpected server error.") });
});
app.get("*path", (req, res) => res.sendFile(path.join(__dirname, "..", "frontend", "index.html")));

app.listen(PORT, () => console.log(`FAQ Help Center running at http://localhost:${PORT}`));
