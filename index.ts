// StudySprint API — verifies the Firebase ID token, then talks to Supabase with the service role.
// Deploy: supabase functions deploy api --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const FB_PROJECT = "studysprint-ke";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ADMIN_UID = Deno.env.get("ADMIN_UID") ?? "";   // Firebase uid of studysprintke@gmail.com
const DAY = 86400000;

const PLANS: Record<string, { days: number; amount: number; label: string }> = {
  S60:  { days: 60,  amount: 50,  label: "2 Months Access" },
  S120: { days: 120, amount: 80,  label: "4 Months Access" },
  S360: { days: 360, amount: 120, label: "Full Academic Year" },
};
const AMOUNT_TO_PLAN: Record<number, string> = { 50: "S60", 80: "S120", 120: "S360" };
const MPESA_RE = /^([A-Z0-9]{10}) Confirmed\. Ksh(\d+)\.00 paid to JOSEPH WAMBUA WANZIA. on \d{1,2}\/\d{1,2}\/\d{2} at \d{1,2}:\d{2} (AM|PM)\.New M-PESA balance is Ksh[\d,]+\.\d{2}\. Transaction cost, Ksh[\d,]+\.\d{2}\. Amount you can transact within the day is [\d,]+\.\d{2}\..*$/i;

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (m: string, s = 400) => json({ error: m }, s);
const clean = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let uid: string, email: string;
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${FB_PROJECT}`, audience: FB_PROJECT });
    uid = payload.sub!; email = String(payload.email ?? "").toLowerCase();
  } catch { return fail("unauthorized", 401); }

  let b: any = {};
  try { b = await req.json(); } catch { /* empty body */ }

  const ensureProfile = () => sb.from("profiles").upsert({ uid, email }, { onConflict: "uid", ignoreDuplicates: true });

  async function grant(planKey: string, source: string, reference: string, amount: number) {
    const p = PLANS[planKey], now = Date.now();
    const { data, error } = await sb.from("subscriptions").insert({
      uid, plan_key: planKey, plan_label: p.label, days: p.days, amount, source, reference,
      activated_at: new Date(now).toISOString(), expires_at: new Date(now + p.days * DAY).toISOString(),
    }).select().single();
    if (error) throw error;
    return data;
  }

  try {
    switch (b.action) {
      case "me": {
        await ensureProfile();
        const [p, s, l, a, d] = await Promise.all([
          sb.from("profiles").select("*").eq("uid", uid).single(),
          sb.from("subscriptions").select("*").eq("uid", uid).order("activated_at", { ascending: false }),
          sb.from("login_activity").select("device,browser,created_at").eq("uid", uid).order("created_at", { ascending: false }).limit(20),
          sb.from("activity_log").select("icon,title,detail,created_at").eq("uid", uid).order("created_at", { ascending: false }).limit(50),
          sb.from("downloads_history").select("link,name,cat,img,opens,last_opened_at").eq("uid", uid).order("last_opened_at", { ascending: false }).limit(300),
        ]);
        return json({ profile: p.data, subscriptions: s.data ?? [], logins: l.data ?? [], activity: a.data ?? [], downloads: d.data ?? [] });
      }

      case "save-profile": {
        const phone = clean(b.phone, 20);
        if (phone && !/^[0-9+ ]{7,15}$/.test(phone)) return fail("Invalid phone number");
        await ensureProfile();
        const { error } = await sb.from("profiles").update({
          name: clean(b.name, 80) || "Student", phone, university: clean(b.university, 80),
          year: clean(b.year, 30), updated_at: new Date().toISOString(),
        }).eq("uid", uid);
        if (error) throw error;
        return json({ ok: true });
      }

      case "upload-avatar": {
        const m = String(b.dataUrl ?? "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return fail("Invalid image");
        const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
        if (bytes.length > 400_000) return fail("Image too large");
        await ensureProfile();
        const path = `${uid}/${Date.now()}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
        const up = await sb.storage.from("avatars").upload(path, bytes, { contentType: `image/${m[1]}` });
        if (up.error) throw up.error;
        const old = await sb.storage.from("avatars").list(uid);        // keep only the newest picture
        const stale = (old.data ?? []).map((f) => `${uid}/${f.name}`).filter((p) => p !== path);
        if (stale.length) await sb.storage.from("avatars").remove(stale);
        const url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
        await sb.from("profiles").update({ avatar_url: url, updated_at: new Date().toISOString() }).eq("uid", uid);
        return json({ url });
      }

      case "log-login":
        await ensureProfile();
        await sb.from("login_activity").insert({ uid, device: clean(b.device, 60), browser: clean(b.browser, 60) });
        return json({ ok: true });

      case "log-activity":
        await sb.from("activity_log").insert({ uid, icon: clean(b.icon, 8), title: clean(b.title, 200), detail: clean(b.detail, 300) });
        return json({ ok: true });

      case "sync-downloads": {           // never goes down, so reinstalling/switching device can't reset the free quota
        const n = Math.max(0, Math.min(1000, Number(b.count) | 0));
        const { data } = await sb.from("profiles").select("free_downloads").eq("uid", uid).single();
        const next = Math.max(n, data?.free_downloads ?? 0);
        await sb.from("profiles").update({ free_downloads: next }).eq("uid", uid);
        return json({ count: next });
      }

      case "record-download": {
        const link = clean(b.link, 1000); if (!link) return fail("Missing link");
        const { data } = await sb.from("downloads_history").select("opens").eq("uid", uid).eq("link", link).maybeSingle();
        await sb.from("downloads_history").upsert({
          uid, link, name: clean(b.name, 200), cat: clean(b.cat, 40), img: clean(b.img, 1000),
          opens: (data?.opens ?? 0) + 1, last_opened_at: new Date().toISOString(),
        });
        return json({ ok: true });
      }

      case "verify-mpesa": {
        const msg = clean(b.message, 600);
        const tx = msg.match(/^([A-Z0-9]{10})/)?.[1];
        if (!tx) return fail("Message does not match a valid M-Pesa payment. Please paste the exact SMS received from M-Pesa.");
        const fp = msg.replace(/\s+/g, " ").trim().toUpperCase();
        await ensureProfile();
        const { data: row } = await sb.from("mpesa_transactions").select("*").eq("tx_code", tx).maybeSingle();
        if (row?.status === "used") return fail("This M-Pesa transaction has already been used.");
        if (row && row.fingerprint !== fp) return fail("Wrong payment done. This message doesn't match the original transaction — payment messages cannot be edited.");
        if (!row) await sb.from("mpesa_transactions").insert({ tx_code: tx, uid, fingerprint: fp });

        const m = msg.match(MPESA_RE);
        const planKey = m ? AMOUNT_TO_PLAN[Number(m[2])] : undefined;
        if (!planKey) return fail("Message does not match a valid M-Pesa payment. Please paste the exact SMS received from M-Pesa.");

        // atomic claim: only one request can flip 'seen' → 'used'
        const claim = await sb.from("mpesa_transactions")
          .update({ status: "used", uid, amount: PLANS[planKey].amount, used_at: new Date().toISOString() })
          .eq("tx_code", tx).eq("status", "seen").select();
        if (!claim.data?.length) return fail("This M-Pesa transaction has already been used.");

        const sub = await grant(planKey, "mpesa", tx, PLANS[planKey].amount);
        await sb.from("activity_log").insert({ uid, icon: "🏆", title: "Subscription activated", detail: `${sub.plan_label} — KSh ${sub.amount}` });
        return json({ subscription: sub });
      }

      case "admin-create-code": {
        if (!ADMIN_UID || uid !== ADMIN_UID) return fail("Forbidden", 403);
        const target = clean(b.email, 120).toLowerCase(), amount = Number(b.amount), key = String(b.planKey);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return fail("Please enter a valid user email address.");
        if (!PLANS[key]) return fail("Please select a subscription period.");
        if (!(amount > 0)) return fail("Please enter the amount paid.");
        const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const rnd = Array.from(crypto.getRandomValues(new Uint8Array(6)), (x) => A[x % A.length]).join("");
        const { error } = await sb.from("activation_codes").insert({ code_norm: key + rnd, display: `${key}-${rnd}`, email: target, plan_key: key, amount });
        if (error) throw error;
        return json({ code: `${key}-${rnd}`, label: PLANS[key].label });
      }

      case "redeem-code": {
        const norm = String(b.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const { data: c } = await sb.from("activation_codes").select("*").eq("code_norm", norm).maybeSingle();
        if (!c) return fail("Invalid code. Please check and try again.");
        if (c.redeemed_by) return fail("This code has already been used.");
        if (c.email !== email) return fail("This code is not valid for your account. Please login with the email the code was generated for.");
        await ensureProfile();
        const claim = await sb.from("activation_codes").update({ redeemed_by: uid, redeemed_at: new Date().toISOString() })
          .eq("code_norm", norm).is("redeemed_by", null).select();
        if (!claim.data?.length) return fail("This code has already been used.");
        const sub = await grant(c.plan_key, "activation_code", c.display, c.amount);
        await sb.from("activity_log").insert({ uid, icon: "🏆", title: "Subscription activated", detail: `${sub.plan_label} — KSh ${sub.amount} (activation code)` });
        return json({ subscription: sub });
      }

      default: return fail("Unknown action");
    }
  } catch (e) {
    console.error(e);
    return fail("Server error. Please try again.", 500);
  }
});
