
(function () {
  const API = "https://wjzzbljuibvominkoavp.supabase.co/functions/v1/payments";   // ← replace

  const J = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const S = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const ms = (t) => new Date(t).getTime();

  async function call(action, data) {
    const u = window._fbAuth && window._fbAuth.currentUser;
    if (!u) throw new Error("Not signed in");
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (await u.getIdToken()) },
      body: JSON.stringify(Object.assign({ action }, data || {}))
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "Request failed"), { status: r.status });
    return j;
  }
  const quiet = (p) => p.catch((e) => console.warn("[cloud]", e.message));

  const toLic = (s) => ({ code: s.reference, plan: s.plan_label, days: s.days, amount: s.amount,
                          activatedAt: ms(s.activated_at), expiresAt: ms(s.expires_at) });

  // Download everything for this user and refill the local cache.
  async function pull() {
    const uid = localStorage.getItem("currentUser");
    if (!uid) return;
    const d = await call("me"), p = d.profile || {};

    const users = J("users", {});
    users[uid] = { name: p.name || "Student", email: p.email || "", phone: p.phone || "",
                   university: p.university || "", year: p.year || "", profilePic: p.avatar_url || "" };
    S("users", users);

    const subs = (d.subscriptions || []).map(toLic);
    const best = subs.slice().sort((a, b) => b.expiresAt - a.expiresAt)[0];
    const lics = J("s_licenses", {});
    if (best) lics[uid] = best; else delete lics[uid];
    S("s_licenses", lics);
    S("s_payments_" + uid, subs);

    const counts = J("downloadCounts", {});
    counts[uid] = Math.max(counts[uid] || 0, p.free_downloads || 0);
    S("downloadCounts", counts);
    if (typeof downloadCounts !== "undefined") downloadCounts[uid] = counts[uid];
    if ((counts[uid] || 0) > (p.free_downloads || 0)) quiet(call("sync-downloads", { count: counts[uid] }));

    const logs = J("ss_login_logs", {});
    logs[uid] = (d.logins || []).slice().reverse().map((l) => ({ device: l.device, browser: l.browser, ts: ms(l.created_at) }));
    S("ss_login_logs", logs);

    S("s_activity_" + uid, (d.activity || []).slice().reverse().map((a) => ({ icon: a.icon, title: a.title, detail: a.detail, ts: ms(a.created_at) })));
    S("s_downloads_" + uid, (d.downloads || []).map((x) => ({ link: x.link, name: x.name, cat: x.cat, img: x.img, ts: ms(x.last_opened_at), opens: x.opens })));
  }

  // Shrink the picked photo to a 256px JPEG before upload.
  function shrink(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(img.width, img.height), c = document.createElement("canvas");
        c.width = c.height = size;
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("Could not read image"));
      img.src = url;
    });
  }

  window.SS = {
    pull,
    saveProfile: (p) => call("save-profile", p),
    uploadAvatar: async (file) => (await call("upload-avatar", { dataUrl: await shrink(file, 256) })).url,
    logLogin: (device, browser) => quiet(call("log-login", { device, browser })),
    logActivity: (icon, title, detail) => quiet(call("log-activity", { icon, title, detail })),
    syncDownloads: (count) => quiet(call("sync-downloads", { count })),
    recordDownload: (d) => quiet(call("record-download", d)),
    verifyMpesa: (message) => call("verify-mpesa", { message }),
    redeemCode: (code) => call("redeem-code", { code }),
    adminCreateCode: (email, planKey, amount) => call("admin-create-code", { email, planKey, amount }),
    // Remove this user's cached data from the device on logout
    clearLocal: (uid) => {
      ["users", "s_licenses", "downloadCounts", "ss_login_logs"].forEach((k) => {
        const o = J(k, {}); delete o[uid]; S(k, o);
      });
      ["s_activity_", "s_payments_", "s_downloads_"].forEach((k) => localStorage.removeItem(k + uid));
    }
  };
})();
