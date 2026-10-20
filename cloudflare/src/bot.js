// Λογική του bot: έλεγχος διαθεσιμότητας HeroSMS, ειδοποιήσεις και αγορές από το Telegram.
// Δεν εξαρτάται από το Cloudflare (παίρνει storage/env/fetch απ' έξω), ώστε να δοκιμάζεται σε Node.

const HERO_URL = "https://hero-sms.com/stubs/handler_api.php";
export const CHECK_TEXT = "🔍 Έλεγχος τώρα";
const MENU = { keyboard: [[{ text: CHECK_TEXT }]], resize_keyboard: true, is_persistent: true };
const CONFIRM_TTL = 5 * 60;   // δευτ.: το κουμπί «Επιβεβαίωση» λήγει μετά από 5 λεπτά
const ASK_TTL = 30 * 60;      // δευτ.: πόσο περιμένει να γράψεις ποσότητα
const BATCH = 20;             // αγορές ανά εκτέλεση (το δωρεάν πλάνο επιτρέπει 50 εξωτερικές κλήσεις)
const ERROR_ALERT_AFTER = 5;  // συνεχόμενα αποτυχημένα λεπτά πριν σε ειδοποιήσει
export const DEMO_OFFER = [0.13, 300];

export class HeroError extends Error {
  constructor(title, details = "") {
    super(`${title} ${details}`.trim());
    this.title = title;
  }
}

export class Bot {
  constructor(storage, env, fetchFn = (...a) => fetch(...a), now = () => Date.now()) {
    this.storage = storage;
    this.env = env;
    this.fetch = fetchFn;
    this.now = now;
  }

  // ------------------------------------------------------------ HeroSMS

  async hero(action, params = {}) {
    const q = new URLSearchParams({ action, api_key: this.env.HERO_API_KEY, ...params });
    const r = await this.fetch(`${HERO_URL}?${q}`, { headers: { "User-Agent": "herosms-notifier/1.0" } });
    const body = (await r.text()).trim();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      if (body.startsWith("<")) throw new HeroError(`HTTP_${r.status}`, "(το HeroSMS απάντησε με σελίδα HTML)");
      if (!r.ok || /^(BAD_|NO_|ERROR|WRONG_)/.test(body)) throw new HeroError(body.slice(0, 100) || `HTTP_${r.status}`);
      return body; // π.χ. "ACCESS_BALANCE:16.09"
    }
    if (data && typeof data === "object" && "title" in data && "details" in data) {
      throw new HeroError(data.title, data.details);
    }
    if (!r.ok) throw new HeroError(`HTTP_${r.status}`);
    return data;
  }

  /** [τιμή, ποσότητα] ή null. hours=null: ενεργοποίηση 20 λεπτών, αλλιώς ενοικίαση. */
  async getOffer(service, country, hours) {
    if (hours) {
      const data = await this.hero("getRentServicesAndCountries", { country, duration: hours });
      const e = data?.services?.[service];
      return e ? [Number(e.price), Number(e.quantity)] : null;
    }
    const data = await this.hero("getPrices", { service, country });
    const e = data?.[String(country)]?.[service];
    return e ? [Number(e.cost), Number(e.count)] : null;
  }

  async getBalance() {
    return Number(String(await this.hero("getBalance")).split(":")[1]);
  }

  async buyRent(service, country, hours) {
    const d = await this.hero("getRentNumber", { service, country, duration: hours });
    if (d?.phone) return { number: d.phone.number, id: d.phone.id, cost: null, end: d.phone.endDate };
    return { number: d.phoneNumber, id: d.activationId, cost: d.activationCost, end: d.activationEndTime };
  }

  // ------------------------------------------------------------ βοηθητικά

  watchList() {
    return String(this.env.WATCH || "").split(",").map(s => s.trim()).filter(Boolean).map(item => {
      const [service, country, hours] = item.split(":").map(s => s.trim());
      return `${service}:${Number(country)}:${hours ? Number(hours) : ""}`;
    });
  }

  static parseKey(key) {
    const [service, country, hours] = key.split(":");
    return { service, country: Number(country), hours: hours ? Number(hours) : null };
  }

  /** 'ot:129:168' -> 'Any other – Greece – 7 days' (τα ονόματα κρατιούνται στη μνήμη του bot) */
  async label(key) {
    const labels = (await this.storage.get("labels")) || {};
    if (labels[key]) return labels[key];
    const { service, country, hours } = Bot.parseKey(key);
    let svc = service, cty = String(country);
    try {
      const s = await this.hero("getServicesList");
      svc = (s.services || []).find(x => x.code === service)?.name || svc;
      const c = await this.hero("getCountries");
      cty = c?.[String(country)]?.eng || cty;
    } catch {
      return `${svc} – ${cty} – ${period(hours)}`; // χωρίς αποθήκευση: θα ξαναδοκιμάσει
    }
    labels[key] = `${svc} – ${cty} – ${period(hours)}`;
    await this.storage.put("labels", labels);
    return labels[key];
  }

  available(offer) {
    const max = this.env.MAX_PRICE ? Number(this.env.MAX_PRICE) : null;
    return !!offer && offer[1] > 0 && (max === null || offer[0] <= max);
  }

  // ------------------------------------------------------------ Telegram

  async tg(method, params) {
    const r = await this.fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  send(text, buttons = null, extra = {}) {
    const params = { chat_id: this.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, ...extra };
    if (buttons) params.reply_markup = { inline_keyboard: buttons };
    return this.tg("sendMessage", params);
  }

  async edit(msg, text, buttons = null) {
    const params = { chat_id: msg.chat.id, message_id: msg.message_id, text, disable_web_page_preview: true };
    if (buttons) params.reply_markup = { inline_keyboard: buttons };
    try {
      await this.tg("editMessageText", params);
    } catch {
      await this.send(text, buttons); // π.χ. πολύ παλιό μήνυμα: στέλνει νέο
    }
  }

  static buyButtons(key, qty, demo) {
    const d = demo ? "|d" : "";
    const row = [1, 5, 10].filter(n => n < qty).map(n => ({ text: `🛒 ${n}`, callback_data: `b|${key}|${n}${d}` }));
    return [row, [{ text: `🛒 Όλους (${qty})`, callback_data: `b|${key}|all${d}` }],
      [{ text: "✏️ Άλλος αριθμός…", callback_data: `a|${key}${d}` }]];
  }

  async alert(key, offer, demo = false, title = "🔔 Διαθέσιμο στο HeroSMS!") {
    const [price, qty] = offer;
    const head = demo ? "🧪 DEMO – εικονική ειδοποίηση\n" : "";
    const text = `${head}${title}\n${await this.label(key)}\nΠοσότητα: ${qty} αριθμοί\nΤιμή: $${price}\nhttps://hero-sms.com`;
    const buttons = Bot.parseKey(key).hours ? Bot.buyButtons(key, qty, demo) : null; // αγορά μόνο για ενοικιάσεις
    await this.send(text, buttons);
  }

  /** Διάγνωση: φτάνει το HeroSMS; (χωρίς να αλλάζει τίποτα) */
  async health() {
    const out = { errorStreak: (await this.storage.get("errorStreak")) || 0, sent: (await this.storage.get("sent")) || {} };
    try {
      out.balance = await this.getBalance();
      out.offers = {};
      for (const key of this.watchList()) {
        const { service, country, hours } = Bot.parseKey(key);
        out.offers[key] = await this.getOffer(service, country, hours);
      }
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    return out;
  }

  // ------------------------------------------------------------ έλεγχος κάθε λεπτό (cron)

  async cron() {
    const sent = (await this.storage.get("sent")) || {};
    let changed = false, error = null;
    for (const key of this.watchList()) {
      const { service, country, hours } = Bot.parseKey(key);
      let offer;
      try {
        offer = await this.getOffer(service, country, hours);
      } catch (e) {
        error = e;
        continue;
      }
      if (!this.available(offer)) {
        if (sent[key]) { sent[key] = null; changed = true; }
      } else if (!sent[key]) {
        await this.alert(key, offer);
        sent[key] = this.now();
        changed = true;
      }
    }
    if (changed) await this.storage.put("sent", sent);
    await this.trackErrors(error);
  }

  /** Μετράει συνεχόμενα σφάλματα· ειδοποιεί μία φορά όταν χαλάσει και μία όταν ξαναδουλέψει. */
  async trackErrors(error) {
    const streak = (await this.storage.get("errorStreak")) || 0;
    if (error) {
      console.log("σφάλμα ελέγχου:", error.message);
      await this.storage.put("errorStreak", streak + 1);
      if (streak + 1 === ERROR_ALERT_AFTER) {
        await this.send(`⚠️ Ο έλεγχος HeroSMS αποτυγχάνει εδώ και ${ERROR_ALERT_AFTER} λεπτά:\n${error.message}`);
      }
    } else if (streak) {
      await this.storage.put("errorStreak", 0);
      if (streak >= ERROR_ALERT_AFTER) await this.send("✅ Ο έλεγχος HeroSMS λειτουργεί ξανά.");
    }
  }

  // ------------------------------------------------------------ Telegram updates (webhook)

  async handleUpdate(upd) {
    // Το Telegram ξαναστέλνει ένα update αν δεν πάρει απάντηση: κάθε update εκτελείται μία φορά.
    const last = (await this.storage.get("lastUpdate")) || 0;
    if (upd.update_id <= last) return;
    await this.storage.put("lastUpdate", upd.update_id);
    try {
      await this.handle(upd);
    } catch (e) {
      console.log("σφάλμα update:", e.message);
      try { await this.send(`⚠️ Σφάλμα: ${e.message}`); } catch { /* τίποτα άλλο να γίνει */ }
    }
  }

  async handle(upd) {
    const me = String(this.env.TELEGRAM_CHAT_ID);
    const cq = upd.callback_query;
    if (cq) {
      const msg = cq.message || {};
      if (String(msg.chat?.id) !== me) return;
      await this.tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      let parts = String(cq.data || "").split("|");
      const demo = parts[parts.length - 1] === "d";
      if (demo) parts = parts.slice(0, -1);
      const [kind, key, arg] = parts;
      if (kind === "b") return this.prepare(key, arg, demo);
      if (kind === "a") return this.askQuantity(key, demo);
      if (kind === "c") {
        if (this.now() / 1000 - (msg.date || 0) > CONFIRM_TTL) {
          return this.edit(msg, "⌛ Η επιβεβαίωση έληξε. Πάτα ξανά ένα κουμπί αγοράς.");
        }
        return this.startPurchase(msg, key, Number(arg), demo);
      }
      if (kind === "x") return this.edit(msg, "❌ Ακυρώθηκε.");
      return;
    }
    const msg = upd.message;
    if (!msg || String(msg.chat?.id) !== me) return;
    const text = String(msg.text || "").trim();
    if (text === CHECK_TEXT || text === "/check") {
      await this.storage.delete("ask");
      return this.manualCheck();
    }
    if (text === "/start") {
      return this.send(`Πάτα «${CHECK_TEXT}» όποτε θες να ελέγξεις τη διαθεσιμότητα.\n` +
        "Άλλες εντολές: /balance (υπόλοιπο), /demo (δοκιμή με εικονικές αγορές).", null, { reply_markup: MENU });
    }
    if (text === "/balance") return this.send(`💰 Υπόλοιπο HeroSMS: $${(await this.getBalance()).toFixed(2)}`);
    if (text === "/demo") {
      const key = this.watchList()[0];
      return this.alert(key, DEMO_OFFER, true);
    }
    const ask = await this.storage.get("ask");
    if (ask && /^\d+$/.test(text) && Number(text) > 0 && this.now() / 1000 - ask.at < ASK_TTL) {
      await this.storage.delete("ask");
      return this.prepare(ask.key, text, ask.demo);
    }
    if (ask && text) return this.send("Γράψε μόνο έναν αριθμό, π.χ. 7");
  }

  async manualCheck() {
    const sent = (await this.storage.get("sent")) || {};
    for (const key of this.watchList()) {
      const { service, country, hours } = Bot.parseKey(key);
      let offer;
      try {
        offer = await this.getOffer(service, country, hours);
      } catch (e) {
        await this.send(`⚠️ Σφάλμα στον έλεγχο: ${e.message}\n${await this.label(key)}`);
        continue;
      }
      if (this.available(offer)) {
        await this.alert(key, offer, false, "🔍 Υπάρχουν διαθέσιμοι!");
        sent[key] = this.now(); // να μην ξαναστείλει ο αυτόματος έλεγχος την ίδια ειδοποίηση
      } else {
        await this.send(`❌ Δεν υπάρχουν διαθέσιμοι τώρα.\n${await this.label(key)}`);
      }
    }
    await this.storage.put("sent", sent);
  }

  async askQuantity(key, demo) {
    await this.storage.put("ask", { key, demo, at: this.now() / 1000 });
    await this.send(`✏️ Πόσους αριθμούς θέλεις να αγοράσεις;\n${await this.label(key)}\nΓράψε μόνο τον αριθμό, π.χ. 7`,
      null, { reply_markup: { force_reply: true } });
  }

  /** Σύνοψη (πόσοι, κόστος, υπόλοιπο) με κουμπιά Επιβεβαίωση / Ακύρωση. */
  async prepare(key, wanted, demo) {
    const { service, country, hours } = Bot.parseKey(key);
    const offer = demo ? DEMO_OFFER : await this.getOffer(service, country, hours);
    if (!offer || offer[1] <= 0) return this.send(`😕 Δεν υπάρχουν πλέον διαθέσιμοι αριθμοί.\n${await this.label(key)}`);
    const [price, qty] = offer;
    const balance = await this.getBalance();
    const affordable = price > 0 ? Math.floor(balance / price) : qty;
    const limit = this.env.MAX_BUY ? Number(this.env.MAX_BUY) : null;
    let n = wanted === "all" ? qty : Math.min(Number(wanted), qty);
    const notes = [];
    if (wanted !== "all" && Number(wanted) > qty) notes.push(`Υπάρχουν μόνο ${qty} διαθέσιμοι.`);
    if (n > affordable) { notes.push(`Το υπόλοιπο φτάνει για ${affordable}.`); n = affordable; }
    if (limit && n > limit) { notes.push(`Όριο MAX_BUY: ${limit}.`); n = limit; }
    if (n <= 0) return this.send(`💸 Δεν φτάνει το υπόλοιπο ($${balance.toFixed(2)}) ούτε για έναν αριθμό ($${price}).`);
    const d = demo ? "|d" : "";
    const text = (demo ? "🧪 DEMO – η αγορά θα είναι εικονική\n" : "") +
      `🛒 Αγορά ${n} αριθμών\n${await this.label(key)}\n` +
      `Τιμή: ~$${price} / αριθμό → σύνολο ~$${(price * n).toFixed(2)}\n` +
      `Υπόλοιπο: $${balance.toFixed(2)}\n` + (notes.length ? notes.join("\n") + "\n" : "") +
      "\nΕπιβεβαιώνεις; (λήγει σε 5 λεπτά)";
    return this.send(text, [[{ text: "✅ Επιβεβαίωση", callback_data: `c|${key}|${n}${d}` },
      { text: "❌ Ακύρωση", callback_data: "x" }]]);
  }

  // ------------------------------------------------------------ αγορά σε παρτίδες (alarm)

  async startPurchase(msg, key, n, demo) {
    if (await this.storage.get("job")) {
      return this.send("⏳ Υπάρχει ήδη αγορά σε εξέλιξη. Περίμενε να τελειώσει.");
    }
    const job = { key, n, demo, bought: [], stop: null, msg: { chat: { id: msg.chat.id }, message_id: msg.message_id } };
    await this.storage.put("job", job);
    await this.edit(job.msg, `⏳ Αγορά ${n} αριθμών σε εξέλιξη… 0/${n}\n${await this.label(key)}`);
    await this.storage.setAlarm(this.now());
  }

  async alarm() {
    const job = await this.storage.get("job");
    if (!job) return;
    const { service, country, hours } = Bot.parseKey(job.key);
    for (let i = 0; i < BATCH && job.bought.length < job.n && !job.stop; i++) {
      try {
        const b = job.demo
          ? { number: `30690000${String(job.bought.length).padStart(4, "0")}`, id: `demo${job.bought.length}`, cost: DEMO_OFFER[0], end: "—" }
          : await this.buyRent(service, country, hours);
        job.bought.push(b);
      } catch (e) {
        job.stop = e.message; // π.χ. NO_NUMBERS, NO_BALANCE: σταματά
      }
      await this.storage.put("job", job); // κάθε αριθμός αποθηκεύεται αμέσως: δεν χάνεται, δεν ξαναγοράζεται
    }
    if (job.bought.length < job.n && !job.stop) {
      await this.edit(job.msg, `⏳ Αγορά ${job.n} αριθμών σε εξέλιξη… ${job.bought.length}/${job.n}\n${await this.label(job.key)}`);
      await this.storage.setAlarm(this.now()); // συνέχεια στην επόμενη παρτίδα
      return;
    }
    await this.finish(job);
  }

  async finish(job) {
    await this.storage.delete("job");
    const { service, country, hours } = Bot.parseKey(job.key);
    const total = job.bought.reduce((s, b) => s + (b.cost != null ? Number(b.cost) : 0), 0);
    let head = (job.demo ? "🧪 DEMO – καμία πραγματική αγορά\n" : "") +
      `${job.bought.length ? "✅" : "❌"} Αγοράστηκαν ${job.bought.length}/${job.n}\n${await this.label(job.key)}\n`;
    if (total) head += `Κόστος: $${total.toFixed(2)}\n`;
    if (job.stop) head += `Σταμάτησε: ${job.stop}\n`;
    await this.edit(job.msg, head.trim());
    const lines = job.bought.map(b => `+${b.number}  (id ${b.id}, λήξη ${b.end})`);
    for (let i = 0; i < lines.length; i += 50) { // έως 4096 χαρακτήρες ανά μήνυμα
      await this.send("📱 Αριθμοί:\n" + lines.slice(i, i + 50).join("\n"));
    }
    console.log(`αγορά ${job.key}: ${job.bought.length}/${job.n} ${job.demo ? "(demo)" : ""} ${job.stop || ""}`);
    // Ρωτάει αμέσως για τους υπόλοιπους.
    let rest;
    try {
      rest = job.demo ? [DEMO_OFFER[0], DEMO_OFFER[1] - job.bought.length] : await this.getOffer(service, country, hours);
    } catch {
      return;
    }
    if (rest && rest[1] > 0) {
      await this.alert(job.key, rest, job.demo, `📦 Απομένουν ${rest[1]} διαθέσιμοι – θέλεις κι άλλους;`);
    } else {
      await this.send(`Δεν απέμειναν άλλοι διαθέσιμοι.\n${await this.label(job.key)}`);
    }
    if (!job.demo) {
      const sent = (await this.storage.get("sent")) || {};
      sent[job.key] = this.now(); // ο αυτόματος έλεγχος να μην ξαναστείλει την ίδια ειδοποίηση
      await this.storage.put("sent", sent);
    }
  }
}

function period(hours) {
  if (!hours) return "20 mins";
  return hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
}
