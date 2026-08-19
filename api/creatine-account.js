import { createClient } from "@supabase/supabase-js";

const allowedOrigins = new Set([
  "https://doubledash.me",
  "https://www.doubledash.me",
  "http://127.0.0.1:4321",
  "http://localhost:4321",
]);

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  if (request.method !== "DELETE") {
    response.setHeader("Allow", "DELETE");
    response.status(405).json({ code: "METHOD_NOT_ALLOWED" });
    return;
  }

  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    response.status(403).json({ code: "ORIGIN_NOT_ALLOWED" });
    return;
  }

  const authorization = request.headers.authorization || "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!accessToken || !supabaseUrl || !serviceKey) {
    response.status(accessToken ? 503 : 401).json({ code: accessToken ? "ACCOUNT_SERVICE_UNAVAILABLE" : "AUTH_REQUIRED" });
    return;
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !data.user?.id) {
    response.status(401).json({ code: "AUTH_REQUIRED" });
    return;
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id, false);
  if (deleteError) {
    console.error("creatine account deletion failed", { code: deleteError.code || "unknown" });
    response.status(500).json({ code: "ACCOUNT_DELETE_FAILED" });
    return;
  }

  response.status(200).json({ status: "deleted" });
}
