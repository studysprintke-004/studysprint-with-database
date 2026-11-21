// StudySprint ADMIN API. Deploy: supabase functions deploy admin --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const FB_PROJECT = "studysprint-ke";
const SUPER = "studysprintke@gmail.com";           // super admin: fixed in code, cannot be removed
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const DAY = 86400000, PER = 25;
const PLANS: Record<string, { days: number; amount: number; label: string }> = {
  S60: { days: 60, amount: 50, label: "2 Months Access" },
  S120: { days: 120, amount: 80, label: "4 Months Access" },
  S360: { days: 360, amount: 120, label: "Full Academic Year" },
};
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (m: string, s = 400) => json({ error: m }, s);
const clean = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const range = (p: number) => [p * PER, p * PER + PER - 1] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let email = "";
  try {
    const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    const { payload } = await jwtVerify(t, JWKS, { issuer: `https://securetoken.google.com/${FB_PROJECT}`, audience: FB_PROJECT });
    email = String(payload.email ?? "").toLowerCase();
  } catch { return fail("unauthorized", 401); }

  const isSuper = email === SUPER;
  if (!isSuper) {
    const { data } = await sb.from("admins").select("email").eq("email", email).maybeSingle();
    if (!data) return fail("Access denied. This account is not an admin.", 403);
  }
  let b: any = {}; try { b = await req.json(); } catch { /* */ }
  const audit = (action: string, target = "", detail = "") => sb.from("admin_audit").insert({ actor: email, action, target, detail });
  const nowIso = () => new Date().toISOString();
  const emailOf = async (uid: string) => (await sb.from("profiles").select("email").eq("uid", uid).maybeSingle()).data?.email ?? "";

  try {
    switch (b.action) {
      case "whoami": return json({ email, role: isSuper ? "super" : "admin" });

      case "stats": {
        const head = { count: "exact", head: true } as const;
        const d7 = new Date(Date.now() - 7 * DAY).toISOString();
        const [u, n7, sus, act, subs, tx, lg] = await Promise.all([
          sb.from("profiles").select("*", head),
          sb.from("profiles").select("*", head).gte("created_at", d7),
          sb.from("profiles").select("*", head).eq("suspended", true),
          sb.from("subscriptions").select("uid").gt("expires_at", nowIso()),
          sb.from("subscriptions").select("amount").limit(20000),
          sb.from("mpesa_transactions").select("*", head).eq("status", "used"),
          sb.from("login_activity").select("*", head).gte("created_at", new Date(Date.now() - DAY).toISOString()),
        ]);
        const active = new Set((act.data ?? []).map((x) => x.uid)).size;
        return json({ users: u.count, newWeek: n7.count, suspended: sus.count, activeSubs: active,
          revenue: (subs.data ?? []).reduce((a, x) => a + x.amount, 0), payments: tx.count, loginsToday: lg.count });
      }

      case "list-users": {
        const [from, to] = range(Math.max(0, b.page | 0));
        let q = sb.from("profiles").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(from, to);
        const s = clean(b.q, 60).replace(/[%,()"]/g, "");
        if (s) q = q.or(`name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
        if (b.filter === "suspended") q = q.eq("suspended", true);
        if (b.filter === "active" || b.filter === "free") {
          const { data: a } = await sb.from("subscriptions").select("uid").gt("expires_at", nowIso());
          const ids = [...new Set((a ?? []).map((x) => x.uid))];
          if (b.filter === "active") q = q.in("uid", ids.length ? ids : ["-"]);
          else if (ids.length) q = q.not("uid", "in", `(${ids.map((i) => `"${i}"`).join(",")})`);
        }
        const { data, count } = await q;
        const uids = (data ?? []).map((u) => u.uid);
        const { data: subs } = await sb.from("subscriptions").select("uid,plan_label,expires_at").in("uid", uids.length ? uids : ["-"]).gt("expires_at", nowIso()).order("expires_at");
        const plan: Record<string, any> = {}; (subs ?? []).forEach((x) => (plan[x.uid] = x));
        return json({ users: (data ?? []).map((u) => ({ ...u, plan: plan[u.uid] ?? null })), total: count ?? 0 });
      }

      case "get-user": {
        const uid = clean(b.uid, 128);
        const [p, s, l, a, d, t] = await Promise.all([
          sb.from("profiles").select("*").eq("uid", uid).maybeSingle(),
          sb.from("subscriptions").select("*").eq("uid", uid).order("activated_at", { ascending: false }),
          sb.from("login_activity").select("*").eq("uid", uid).order("created_at", { ascending: false }).limit(30),
          sb.from("activity_log").select("*").eq("uid", uid).order("created_at", { ascending: false }).limit(50),
          sb.from("downloads_history").select("name,cat,opens,last_opened_at").eq("uid", uid).order("last_opened_at", { ascending: false }).limit(30),
          sb.from("mpesa_transactions").select("*").eq("uid", uid).order("first_seen_at", { ascending: false }),
        ]);
        if (!p.data) return fail("User not found", 404);
        return json({ profile: p.data, subs: s.data, logins: l.data, activity: a.data, downloads: d.data, mpesa: t.data });
      }

      case "update-user": {
        const uid = clean(b.uid, 128), target = await emailOf(uid);
        if (target === SUPER && b.suspended) return fail("The super admin cannot be suspended.");
        const phone = clean(b.phone, 20);
        if (phone && !/^[0-9+ ]{7,15}$/.test(phone)) return fail("Invalid phone number");
        const { error } = await sb.from("profiles").update({
          name: clean(b.name, 80) || "Student", phone, university: clean(b.university, 80), year: clean(b.year, 30),
          free_downloads: Math.max(0, Math.min(1000, Number(b.free_downloads) | 0)), suspended: !!b.suspended, updated_at: nowIso(),
        }).eq("uid", uid);
        if (error) throw error;
        await audit("update-user", target, b.suspended ? "suspended" : "saved");
        return json({ ok: true });
      }

      case "grant-subscription": {
        const uid = clean(b.uid, 128), key = String(b.planKey), plan = PLANS[key];
        const days = Math.max(1, Math.min(800, Number(b.days) | 0 || plan?.days || 0));
        if (!plan && key !== "CUSTOM") return fail("Choose a plan");
        if (!days) return fail("Enter number of days");
        const amount = Math.max(0, Number(b.amount) | 0);
        const { error } = await sb.from("subscriptions").insert({
          uid, plan_key: key, plan_label: plan && days === plan.days ? plan.label : `${days} Days Access`, days, amount,
          source: "admin", reference: `by ${email}`, expires_at: new Date(Date.now() + days * DAY).toISOString(),
        });
        if (error) throw error;
        await sb.from("activity_log").insert({ uid, icon: "🏆", title: "Subscription activated", detail: `${days} days (granted by admin)` });
        await audit("grant-subscription", await emailOf(uid), `${key} ${days}d KSh ${amount}`);
        return json({ ok: true });
      }

      case "extend-subscription": {
        const { data: s } = await sb.from("subscriptions").select("*").eq("id", b.id).single();
        const days = Math.max(-800, Math.min(800, Number(b.days) | 0));
        await sb.from("subscriptions").update({ expires_at: new Date(new Date(s.expires_at).getTime() + days * DAY).toISOString() }).eq("id", b.id);
        await audit("extend-subscription", await emailOf(s.uid), `${days > 0 ? "+" : ""}${days}d`);
        return json({ ok: true });
      }

      case "revoke-subscription": {
        const { data: s } = await sb.from("subscriptions").select("uid").eq("id", b.id).single();
        await sb.from("subscriptions").update({ expires_at: nowIso() }).eq("id", b.id);
        await audit("revoke-subscription", await emailOf(s.uid));
        return json({ ok: true });
      }

      case "delete-user": {   // removes the user's Supabase data (their Firebase login is untouched; use Suspend to block)
        const uid = clean(b.uid, 128), target = await emailOf(uid);
        if (target === SUPER) return fail("The super admin cannot be deleted.");
        for (const t of ["subscriptions", "login_activity", "activity_log", "downloads_history", "profiles"]) await sb.from(t).delete().eq("uid", uid);
        const old = await sb.storage.from("avatars").list(uid);
        if (old.data?.length) await sb.storage.from("avatars").remove(old.data.map((f) => `${uid}/${f.name}`));
        await audit("delete-user", target);
        return json({ ok: true });
      }

      case "list-payments": {
        const [from, to] = range(Math.max(0, b.page | 0));
        const { data, count } = await sb.from("mpesa_transactions").select("*", { count: "exact" }).order("first_seen_at", { ascending: false }).range(from, to);
        const uids = [...new Set((data ?? []).map((x) => x.uid))];
        const { data: ps } = await sb.from("profiles").select("uid,email").in("uid", uids.length ? uids : ["-"]);
        const em: Record<string, string> = {}; (ps ?? []).forEach((p) => (em[p.uid] = p.email));
        return json({ rows: (data ?? []).map((x) => ({ ...x, email: em[x.uid] ?? "" })), total: count ?? 0 });
      }

      case "list-codes": {
        const [from, to] = range(Math.max(0, b.page | 0));
        const { data, count } = await sb.from("activation_codes").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(from, to);
        return json({ rows: data ?? [], total: count ?? 0 });
      }

      case "create-code": {
        const target = clean(b.email, 120).toLowerCase(), amount = Number(b.amount), key = String(b.planKey);
        if (!isEmail(target)) return fail("Enter a valid user email.");
        if (!PLANS[key]) return fail("Choose a plan.");
        if (!(amount > 0)) return fail("Enter the amount paid.");
        const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const rnd = Array.from(crypto.getRandomValues(new Uint8Array(6)), (x) => A[x % A.length]).join("");
        const { error } = await sb.from("activation_codes").insert({ code_norm: key + rnd, display: `${key}-${rnd}`, email: target, plan_key: key, amount });
        if (error) throw error;
        await audit("create-code", target, `${key}-${rnd}`);
        return json({ code: `${key}-${rnd}` });
      }

      case "delete-code":
        await sb.from("activation_codes").delete().eq("code_norm", clean(b.code, 40)).is("redeemed_by", null);
        await audit("delete-code", clean(b.code, 40));
        return json({ ok: true });

      case "list-admins": {
        const { data } = await sb.from("admins").select("*").order("created_at");
        return json({ super: SUPER, admins: data ?? [], role: isSuper ? "super" : "admin" });
      }
      case "add-admin": {
        if (!isSuper) return fail("Only the super admin can add admins.", 403);
        const target = clean(b.email, 120).toLowerCase();
        if (!isEmail(target)) return fail("Enter a valid email.");
        if (target === SUPER) return fail("That account is already the super admin.");
        const { error } = await sb.from("admins").upsert({ email: target, added_by: email });
        if (error) throw error;
        await audit("add-admin", target);
        return json({ ok: true });
      }
      case "remove-admin": {
        if (!isSuper) return fail("Only the super admin can remove admins.", 403);
        const target = clean(b.email, 120).toLowerCase();
        if (target === SUPER) return fail("The super admin cannot be removed.");
        await sb.from("admins").delete().eq("email", target);
        await audit("remove-admin", target);
        return json({ ok: true });
      }

      case "audit": {
        const [from, to] = range(Math.max(0, b.page | 0));
        const { data, count } = await sb.from("admin_audit").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(from, to);
        return json({ rows: data ?? [], total: count ?? 0 });
      }
      default: return fail("Unknown action");
    }
  } catch (e) { console.error(e); return fail("Server error. Please try again.", 500); }
});
