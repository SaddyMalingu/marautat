#!/usr/bin/env node
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const sb = createClient(process.env.SB_URL, process.env.SB_SERVICE_ROLE_KEY);

const fields = [
  "client_name",
  "client_phone",
  "status",
  "whatsapp_phone_number_id",
  "whatsapp_business_account_id"
].join(",");

const { data, error } = await sb.from("bot_tenants").select(fields).limit(50);
if (error) {
  console.error("ERROR:", error.message);
  process.exit(1);
}

console.log(JSON.stringify(data || [], null, 2));
