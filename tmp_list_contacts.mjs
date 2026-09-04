import dotenv from "dotenv";
dotenv.config();
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.SB_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.log("Missing Supabase credentials in .env");
  process.exit(1);
}

const sb = createClient(url, key);

// Check user_sessions
const { data: sessions, error: sessErr } = await sb
  .from("user_sessions")
  .select("phone, updated_at")
  .order("updated_at", { ascending: false })
  .limit(200);

if (sessErr) {
  console.log("user_sessions error:", sessErr.message);
} else {
  const unique = [...new Set((sessions || []).map(r => r.phone).filter(Boolean))];
  console.log("=== user_sessions contacts:", unique.length, "===");
  unique.slice(0, 30).forEach(p => console.log(" ", p));
}

// Also check conversations table
const { data: convs, error: convErr } = await sb
  .from("conversations")
  .select("phone, direction, created_at")
  .eq("direction", "incoming")
  .order("created_at", { ascending: false })
  .limit(200);

if (convErr) {
  console.log("conversations error:", convErr.message);
} else {
  const uniqueConv = [...new Set((convs || []).map(r => r.phone).filter(Boolean))];
  console.log("\n=== conversations (inbound) contacts:", uniqueConv.length, "===");
  uniqueConv.slice(0, 30).forEach(p => console.log(" ", p));
}
