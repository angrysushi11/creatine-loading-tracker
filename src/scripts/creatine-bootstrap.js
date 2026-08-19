import { createClient, navigatorLock } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (supabaseUrl && supabaseKey) {
  globalThis.__CREATINE_AUTH_LOCK__ = navigatorLock;
  globalThis.__CREATINE_SUPABASE_CLIENT__ = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      lock: navigatorLock,
      persistSession: true,
      storageKey: "doubledash.creatine-auth.v1",
    },
  });
}

await new Promise((resolve, reject) => {
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/tools/creatine-loading.js";
  script.addEventListener("load", resolve, { once: true });
  script.addEventListener("error", () => reject(new Error("The tracker module could not be loaded.")), { once: true });
  document.head.append(script);
});
