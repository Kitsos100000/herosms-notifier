// Λογική του bot: έλεγχος διαθεσιμότητας HeroSMS, ειδοποιήσεις και αγορές από το Telegram.
// Δεν εξαρτάται από το Cloudflare (παίρνει storage/env/fetch απ' έξω), ώστε να δοκιμάζεται σε Node.

const HERO_URL = "https://hero-sms.com/stubs/handler_api.php";
const HERO_V1 = "https://hero-sms.com/api/v1";
const PAGE_SIZE = 25;         // μέγιστο που δέχεται το /activations
const STEP_BUDGET = 35;       // κλήσεις HeroSMS ανά εκτέλεση για /list και /scan (όριο δωρεάν πλάνου: 50)
const DEFAULT_SENDER = "PREDICT2WIN";
const HERO_GAP_MS = 300;      // ελάχιστη απόσταση ανάμεσα σε αιτήσεις HeroSMS (να μη μοιάζουμε με επίθεση)
const SNAPSHOT_TTL = 60 * 60; // δευτ.: πόσο ισχύει η λίστα του /list ή /clean για το /complete
const FIN_CODE_TTL = 5 * 60;  // δευτ.: πόσο ισχύει ο κωδικός /confirm
export const CHECK_TEXT = "🔍 Έλεγχος τώρα";
export const CLEAN_TEXT = "📋 Καθαρή λίστα";
// Χωρίς κουμπιά κάτω από το πεδίο γραφής: όλα γίνονται από το Menu του bot (setMyCommands).
// Τα κείμενα των παλιών κουμπιών γίνονται ακόμα δεκτά, αν σταλούν.
const NO_KEYBOARD = { remove_keyboard: true };
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

  /** Περιμένει ώστε δύο αιτήσεις προς το HeroSMS να απέχουν τουλάχιστον HERO_GAP_MS. */
  async pace() {
    const wait = (this.lastHero || 0) + HERO_GAP_MS - Date.now();
    if (wait > 0 && !this.env.NO_PACING) await new Promise(res => setTimeout(res, wait));
    this.lastHero = Date.now();
  }

  async hero(action, params = {}) {
    await this.pace();
    const q = new URLSearchParams({ action, api_key: this.env.HERO_API_KEY, ...params });
    const r = await this.fetch(`${HERO_URL}?${q}`, { headers: { "User-Agent": "herosms-notifier/1.0" } });
    const body = (await r.text()).trim();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      if (body.startsWith("<")) throw new HeroError(`HTTP_${r.status}`, htmlHint(body, r));
      if (!r.ok || /^(BAD_|NO_|ERROR|WRONG_)/.test(body)) throw new HeroError(body.slice(0, 100) || `HTTP_${r.status}`);
      return body; // π.χ. "ACCESS_BALANCE:16.09"
    }
    if (data && typeof data === "object" && "title" in data && "details" in data) {
      throw new HeroError(data.title, data.details);
    }
    if (!r.ok) throw new HeroError(`HTTP_${r.status}`);
    return data;
  }

  /** Νέο API του HeroSMS (/api/v1): λίστα αριθμών, SMS, ολοκλήρωση. Τα σφάλματα έχουν .status (HTTP). */
  async heroV1(path, params = {}, method = "GET") {
    await this.pace();
    const q = new URLSearchParams(params);
    const r = await this.fetch(`${HERO_V1}${path}${String(q) ? `?${q}` : ""}`, {
      method,
      headers: { Authorization: `ApiKey ${this.env.HERO_API_KEY}`, "User-Agent": "herosms-notifier/1.0" },
    });
    const body = (await r.text()).trim();
    if (r.ok && !body) return null; // π.χ. 204 No Content
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      const e = new HeroError(`HTTP_${r.status}`, body.startsWith("<") ? htmlHint(body, r) : body.slice(0, 100));
      e.status = r.ok ? 502 : r.status; // απάντηση που δεν καταλαβαίνουμε: γενικό σφάλμα
      throw e;
    }
    if (!r.ok) {
      const e = new HeroError(data?.title || `HTTP_${r.status}`, data?.details || "");
      e.status = r.status;
      throw e;
    }
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
      if (kind === "xf") {
        await this.storage.delete("finPending");
        return this.edit(msg, "❌ Ακυρώθηκε το Complete activation. Δεν έγινε καμία αλλαγή.");
      }
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
      return this.send("Όλες οι εντολές είναι στο Menu του bot:\n" +
        "/check – έλεγχος διαθεσιμότητας τώρα\n" +
        "/list – ενεργοί αριθμοί (νεότερος → παλαιότερος)\n" +
        "/clean – μόνο οι αριθμοί (69xxxxxxxx), ένας ανά γραμμή\n" +
        "/complete 350-400 – Complete activation στις θέσεις της λίστας (με επιβεβαίωση)\n" +
        `/scan – ποιοι αριθμοί έλαβαν SMS από ${DEFAULT_SENDER} (ή /scan ΑΠΟΣΤΟΛΕΑΣ)\n` +
        "/balance – υπόλοιπο\n/demo – δοκιμή με εικονικές αγορές", null, { reply_markup: NO_KEYBOARD });
    }
    const [cmd, ...args] = text.split(/\s+/);
    const command = cmd.toLowerCase().replace(/@.*$/, ""); // π.χ. /list@Kitsos_HeroSMS_bot
    if (command === "/complete") return this.prepareFinish(args.join(" "));
    if (command === "/confirm") return this.confirmFinish(args.join(" "));
    if (command === "/list") return this.startReport("list");
    if (command === "/clean" || text === CLEAN_TEXT) return this.startReport("clean");
    if (command === "/scan") return this.startReport("scan", args.join(" ") || this.env.SCAN_SENDER || DEFAULT_SENDER);
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

  /** Κάθε alarm κάνει ένα βήμα: πρώτα τις αγορές, αλλιώς τη λίστα / σάρωση. */
  async alarm() {
    const more = (await this.storage.get("job")) ? await this.purchaseStep()
      : (await this.storage.get("fin")) ? await this.finishStep()
      : await this.reportStep();
    if (more || (await this.storage.get("job")) || (await this.storage.get("fin")) || (await this.storage.get("report"))) {
      await this.storage.setAlarm(this.now()); // συνέχεια στο επόμενο βήμα
    }
  }

  /** Μια παρτίδα αγορών. Επιστρέφει true αν μένουν κι άλλες. */
  async purchaseStep() {
    const job = await this.storage.get("job");
    if (!job) return false;
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
      return true;
    }
    await this.finish(job);
    return false;
  }

  // ------------------------------------------------------------ /list και /scan

  /** Ξεκινά λίστα ενεργών αριθμών (type "list") ή σάρωση SMS από αποστολέα (type "scan"). */
  async startReport(type, sender = null) {
    if (await this.storage.get("report")) return this.send("⏳ Υπάρχει ήδη λίστα/σάρωση σε εξέλιξη. Περίμενε λίγο.");
    await this.storage.put("report", { type, sender, page: 1, total: null, listed: false, items: [], queue: null, matches: {} });
    if (type === "list") await this.send("⏳ Διαβάζω τους ενεργούς αριθμούς…");
    if (type === "scan") await this.send(`⏳ Σαρώνω τα SMS όλων των αριθμών για «${sender}»…`);
    // η «clean» δεν στέλνει τίποτα άλλο εκτός από τους αριθμούς
    await this.storage.setAlarm(this.now());
  }

  /** Ένα βήμα (έως STEP_BUDGET κλήσεις). Επιστρέφει true αν μένει δουλειά. */
  async reportStep() {
    const rep = await this.storage.get("report");
    if (!rep) return false;
    let calls = 0;
    try {
      // 1. Όλες οι σελίδες των ενεργών αριθμών (έρχονται από τον νεότερο στον παλαιότερο).
      while (!rep.listed && calls < STEP_BUDGET) {
        const d = await this.heroV1("/activations", { size: PAGE_SIZE, page: rep.page });
        calls++;
        const data = d.data || [];
        if (d.meta?.total != null) rep.total = d.meta.total;
        const seen = new Set(rep.items.map(a => a.id));
        for (const a of data) if (!seen.has(String(a.id))) rep.items.push(compact(a));
        rep.page++;
        if (data.length < PAGE_SIZE || d.meta?.hasMore === false && d.meta?.total == null ||
            (rep.total != null && (rep.page - 1) * PAGE_SIZE >= rep.total)) rep.listed = true;
        await this.storage.put("report", rep);
      }
      if (!rep.listed) return true;

      if (rep.type === "scan") {
        // 2. Όσοι έχουν ένα SMS: φαίνεται ήδη στη λίστα. Όσοι έχουν περισσότερα: ζητάμε όλα τους τα SMS.
        if (!rep.queue) {
          rep.queue = [];
          for (const a of rep.items) {
            if (a.otpCount > 1) rep.queue.push(a.id);
            else if (a.last && sameSender(a.last.from, rep.sender)) addMatch(rep, a.id, a.last);
          }
        }
        while (rep.queue.length && calls < STEP_BUDGET) {
          const id = rep.queue[0];
          for (let page = 1; calls < STEP_BUDGET; page++) {
            const d = await this.heroV1(`/activations/${id}/otp`, { size: PAGE_SIZE, page });
            calls++;
            for (const m of d.data || []) {
              if (sameSender(m.phoneFrom, rep.sender)) {
                addMatch(rep, id, { from: m.phoneFrom, text: m.smsText, code: m.smsCode, at: m.receivedAt });
              }
            }
            if ((d.data || []).length < PAGE_SIZE || d.meta?.hasMore === false) { rep.queue.shift(); break; }
          }
          await this.storage.put("report", rep);
        }
        if (rep.queue.length) return true;
      }
    } catch (e) {
      await this.storage.delete("report");
      await this.send(`⚠️ Σφάλμα στο /${rep.type}: ${e.message}`);
      return false;
    }
    await this.storage.delete("report");
    if (rep.type === "list") await this.sendList(rep);
    else if (rep.type === "clean") await this.sendClean(rep);
    else await this.sendScan(rep);
    return false;
  }

  /** Ενεργοί αριθμοί, νεότερος → παλαιότερος. */
  activeItems(rep) {
    const now = new Date(this.now()).toISOString();
    return rep.items.filter(a => !a.expiredAt || a.expiredAt > now)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Μόνο οι αριθμοί σε μορφή 69xxxxxxxx, ένας ανά γραμμή, χωρίς τίποτα άλλο. */
  // ------------------------------------------------------------ /complete (Complete activation)
  // Μη αναστρέψιμο: ο αριθμός σταματά να λαμβάνει SMS και τα χρήματα δεν επιστρέφονται. Γι' αυτό:
  // θέσεις μόνο από τη λίστα που είδες, σύνοψη, γραπτός κωδικός μίας χρήσης, εκτέλεση βήμα-βήμα.

  async prepareFinish(spec) {
    if (!spec.trim()) {
      return this.send("Γράψε τις θέσεις από το /list ή το /clean, π.χ.\n/complete 350-400\n/complete 5\n/complete 1-3,7,10-12");
    }
    if ((await this.storage.get("job")) || (await this.storage.get("fin"))) {
      return this.send("⏳ Υπάρχει ήδη αγορά ή Complete activation σε εξέλιξη. Περίμενε να τελειώσει.");
    }
    const snap = await this.storage.get("snapshot");
    if (!snap || this.now() - snap.at > SNAPSHOT_TTL * 1000) {
      return this.send("Γράψε πρώτα /list ή /clean, για να δεις τη λίστα στην οποία αναφέρονται οι θέσεις.\n" +
        "(Η λίστα ισχύει 60 λεπτά και μόνο μέχρι το επόμενο Complete activation.)");
    }
    const parsed = parsePositions(spec, snap.items.length);
    if (parsed.error) return this.send(`❌ ${parsed.error}\nΔεν έγινε καμία αλλαγή.`);
    const items = parsed.positions.map(pos => ({ pos, ...snap.items[pos - 1] }));
    const code = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
    await this.storage.put("finPending", { items, code, at: this.now() });
    const first = items[0], last = items[items.length - 1];
    await this.sendLines(
      "⚠️ COMPLETE ACTIVATION – ΜΗ ΑΝΑΣΤΡΕΨΙΜΟ\n" +
      "Οι αριθμοί θα σταματήσουν να λαμβάνουν SMS και τα χρήματα ΔΕΝ επιστρέφονται.\n\n" +
      `Θέσεις: ${parsed.normalized} από τη λίστα της ${fmtDate(new Date(snap.at).toISOString())} (${snap.items.length} αριθμοί)\n` +
      `Σύνολο: ${items.length} αριθμοί\n` +
      `Πρώτος: #${first.pos} ${localPhone(first.phone)}\nΤελευταίος: #${last.pos} ${localPhone(last.phone)}\n\nΌλοι:`,
      items.map(it => `#${it.pos} ${localPhone(it.phone)}`));
    await this.send(`Για επιβεβαίωση γράψε ακριβώς:\n/confirm ${code}\n\n` +
      `(ισχύει ${FIN_CODE_TTL / 60} λεπτά και μία φορά· λάθος κωδικός = ακύρωση)`,
      [[{ text: "❌ Ακύρωση", callback_data: "xf" }]]);
  }

  async confirmFinish(codeArg) {
    const p = await this.storage.get("finPending");
    if (!p) return this.send("Δεν υπάρχει εκκρεμές Complete activation. Ξεκίνα με /complete.");
    await this.storage.delete("finPending"); // μίας χρήσης, ό,τι κι αν γίνει παρακάτω
    if (this.now() - p.at > FIN_CODE_TTL * 1000) return this.send("⌛ Ο κωδικός έληξε. Δεν έγινε καμία αλλαγή.");
    if (codeArg.trim() !== String(p.code)) return this.send("❌ Λάθος κωδικός. Ακυρώθηκε, δεν έγινε καμία αλλαγή.");
    if ((await this.storage.get("job")) || (await this.storage.get("fin"))) {
      return this.send("⏳ Υπάρχει ήδη αγορά ή Complete activation σε εξέλιξη. Δεν έγινε καμία αλλαγή.");
    }
    await this.storage.delete("snapshot"); // μετά από αυτό οι θέσεις αλλάζουν: χρειάζεται νέο /list
    const msg = await this.send(`⏳ Complete activation σε εξέλιξη… 0/${p.items.length}`);
    await this.storage.put("fin", { items: p.items, idx: 0, done: [], failed: [], stop: null,
      msg: { chat: { id: msg.chat.id }, message_id: msg.message_id } });
    await this.storage.setAlarm(this.now());
  }

  /** Ένα βήμα ολοκληρώσεων. Επιστρέφει true αν μένουν κι άλλες. */
  async finishStep() {
    const fin = await this.storage.get("fin");
    if (!fin) return false;
    for (let calls = 0; fin.idx < fin.items.length && !fin.stop && calls < STEP_BUDGET; calls++) {
      const it = fin.items[fin.idx];
      try {
        await this.heroV1(`/activations/${encodeURIComponent(it.id)}/finish`, {}, "POST");
        fin.done.push(it);
      } catch (e) {
        // Γενικό σφάλμα (κλειδί, όριο, server, δίκτυο): σταματά όλο, χωρίς να προχωρήσει.
        if (!e.status || e.status === 401 || e.status === 403 || e.status === 429 || e.status >= 500) {
          fin.stop = e.message;
          await this.storage.put("fin", fin);
          break;
        }
        fin.failed.push({ ...it, reason: e.message }); // σφάλμα μόνο αυτού του αριθμού: συνεχίζει
      }
      fin.idx++;
      await this.storage.put("fin", fin); // κάθε ολοκλήρωση αποθηκεύεται αμέσως
    }
    if (fin.idx < fin.items.length && !fin.stop) {
      await this.edit(fin.msg, `⏳ Complete activation σε εξέλιξη… ${fin.idx}/${fin.items.length}`);
      return true;
    }
    await this.storage.delete("fin");
    const notDone = fin.items.slice(fin.idx);
    let head = `${fin.done.length === fin.items.length ? "✅" : "⚠️"} Complete activation: ` +
      `${fin.done.length}/${fin.items.length} ολοκληρώθηκαν`;
    if (fin.failed.length) head += `\n❌ ${fin.failed.length} απέτυχαν (δεν άλλαξαν)`;
    if (fin.stop) head += `\n⛔ Σταμάτησε: ${fin.stop}\n${notDone.length} δεν έγιναν (δεν άλλαξαν)`;
    head += "\nΓια νέο /complete γράψε πρώτα ξανά /list (οι θέσεις άλλαξαν).";
    await this.edit(fin.msg, head);
    const lines = [
      ...fin.failed.map(it => `❌ #${it.pos} ${localPhone(it.phone)} – ${it.reason}`),
      ...notDone.map(it => `⏸ #${it.pos} ${localPhone(it.phone)} – δεν έγινε`),
    ];
    if (lines.length) await this.sendLines("Αριθμοί που ΔΕΝ ολοκληρώθηκαν:", lines);
    console.log(`complete: ${fin.done.length}/${fin.items.length} ${fin.stop || ""}`);
    return false;
  }

  /** Κρατά τη λίστα που είδες (ίδια σειρά με /list και /clean): σε αυτή αναφέρονται οι θέσεις του /complete. */
  async saveSnapshot(active) {
    await this.storage.put("snapshot", { at: this.now(), items: active.map(a => ({ id: a.id, phone: a.phone })) });
  }

  async sendClean(rep) {
    const active = this.activeItems(rep);
    await this.saveSnapshot(active);
    if (!active.length) return this.send("📋 Δεν υπάρχουν ενεργοί αριθμοί.");
    let msg = "";
    for (const line of active.map(a => localPhone(a.phone))) {
      if (msg.length + line.length + 1 > 4000) { await this.send(msg); msg = ""; }
      msg += (msg ? "\n" : "") + line;
    }
    if (msg) await this.send(msg);
  }

  async sendList(rep) {
    const active = this.activeItems(rep);
    await this.saveSnapshot(active);
    if (!active.length) return this.send("📋 Δεν υπάρχουν ενεργοί αριθμοί.");
    const lines = active.map((a, i) =>
      `${i + 1}. +${a.phone} · ${fmtDate(a.createdAt)} → ${fmtDate(a.expiredAt)}${a.otpCount ? ` · 📩 ${a.otpCount}` : ""}`);
    await this.sendLines(`📋 Ενεργοί αριθμοί: ${active.length} (νεότερος → παλαιότερος)\nαγορά → λήξη · 📩 = SMS`, lines);
  }

  async sendScan(rep) {
    const now = new Date(this.now()).toISOString();
    const active = rep.items.filter(a => !a.expiredAt || a.expiredAt > now);
    const byId = Object.fromEntries(active.map(a => [a.id, a]));
    const hits = Object.entries(rep.matches).filter(([id]) => byId[id])
      .map(([id, ms]) => ({ a: byId[id], ms: ms.sort((x, y) => String(y.at).localeCompare(String(x.at))) }))
      .sort((x, y) => String(y.ms[0].at).localeCompare(String(x.ms[0].at)));
    const withSms = active.filter(a => a.otpCount > 0).length;
    if (!hits.length) {
      return this.send(`🔎 Κανένας αριθμός δεν έχει λάβει SMS από «${rep.sender}».\n` +
        `Σαρώθηκαν ${active.length} ενεργοί αριθμοί (${withSms} με SMS).`);
    }
    const lines = hits.map(({ a, ms }, i) => {
      const m = ms[0];
      // Το HeroSMS βάζει συχνά όλο το μήνυμα στο «code»: κωδικός μόνο αν είναι πραγματικά σύντομος.
      const code = String(m.code || "").trim();
      const text = cleanText(m.text || code);
      const what = /^[\w-]{3,10}$/.test(code) ? `κωδικός ${code}` : `«${text.length > 100 ? text.slice(0, 100) + "…" : text}»`;
      return `${i + 1}. +${a.phone} · ${fmtDate(m.at)} · ${what}${ms.length > 1 ? ` (${ms.length} SMS)` : ""}`;
    });
    await this.sendLines(`🔎 SMS από «${rep.sender}»: ${hits.length} αριθμοί\n` +
      `(σαρώθηκαν ${active.length} ενεργοί, ${withSms} με SMS · νεότερο → παλαιότερο)`, lines);
  }

  /** Στέλνει μια λίστα σε όσα μηνύματα χρειάζονται (όριο Telegram: 4096 χαρακτήρες). */
  async sendLines(header, lines) {
    let msg = header + "\n";
    for (const line of lines) {
      if (msg.length + line.length + 1 > 3900) { await this.send(msg.trim()); msg = ""; }
      msg += "\n" + line;
    }
    if (msg.trim()) await this.send(msg.trim());
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

/**
 * '350-400' / '5' / '1-3,7,10-12' -> θέσεις 1..n (ταξινομημένες, χωρίς διπλές) ή { error }.
 * Αυστηρό: μόνο αριθμοί, παύλες και κόμματα. Οτιδήποτε άλλο απορρίπτεται.
 */
export function parsePositions(spec, n) {
  // Κενά μόνο γύρω από - και , (π.χ. «350 - 400»). Κενό ανάμεσα σε αριθμούς («1 2») ΔΕΝ ενώνεται σε «12»: απορρίπτεται.
  const s = String(spec || "").replace(/[–—−]/g, "-").trim().replace(/\s*([-,])\s*/g, "$1");
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(s)) {
    return { error: `Μη έγκυρη μορφή «${spec}». Γράψε π.χ. 350-400 ή 5 ή 1-3,7` };
  }
  const set = new Set();
  for (const part of s.split(",")) {
    const [a, b = a] = part.split("-").map(Number);
    if (a < 1) return { error: "Οι θέσεις αρχίζουν από το 1." };
    if (a > b) return { error: `«${part}»: η αρχή είναι μεγαλύτερη από το τέλος.` };
    if (b > n) return { error: `Η θέση ${b} δεν υπάρχει: η λίστα έχει ${n} αριθμούς.` };
    for (let i = a; i <= b; i++) set.add(i);
  }
  const positions = [...set].sort((x, y) => x - y);
  return { positions, normalized: s };
}

/** 306912345678 -> 6912345678 (χωρίς το +30 της Ελλάδας) */
function localPhone(phone) {
  const p = String(phone).replace(/\D/g, "");
  return p.startsWith("30") && p.length === 12 ? p.slice(2) : p;
}

/** Κρατά μόνο ό,τι χρειάζεται από έναν αριθμό του /activations. */
function compact(a) {
  const o = a.otpLast;
  return {
    id: String(a.id), phone: String(a.phone), createdAt: a.createdAt, expiredAt: a.expiredAt,
    otpCount: Number(a.otpTotalCount || 0),
    last: o ? { from: o.phoneFrom, text: o.smsText, code: o.smsCode, at: o.receivedAt } : null,
  };
}

/** Σελίδα HTML αντί για απάντηση API (συνήθως μπλόκο Cloudflare): τίτλος + κωδικός για διάγνωση. */
function htmlHint(body, r) {
  const title = (body.match(/<title>([^<]*)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const code = body.match(/Error code:?\s*(\d{4})/i)?.[1] || body.match(/error-(\d{4})/)?.[1];
  const ray = r.headers?.get?.("cf-ray");
  const kind = /rate limited|error 1015/i.test(body) ? "όριο ρυθμού"
    : /you have been blocked|error 1020|access denied/i.test(body) ? "μπλόκο τείχους προστασίας"
    : /challenge|enable javascript|verify you are human/i.test(body) ? "έλεγχος bot" : "";
  return `(σελίδα HTML${title ? `: «${title}»` : ""}${kind ? `, ${kind}` : ""}${code ? `, κωδικός ${code}` : ""}${ray ? `, ray ${ray}` : ""})`;
}

/** Κείμενο SMS σε μία γραμμή, χωρίς HTML entities (&#10; &#38; &amp; ...). */
function cleanText(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => named[n])
    .replace(/\s+/g, " ").trim();
}

function sameSender(from, sender) {
  const norm = s => String(s || "").replace(/\s+/g, "").toUpperCase();
  return norm(from) === norm(sender);
}

function addMatch(rep, id, sms) {
  const list = (rep.matches[id] ||= []);
  if (!list.some(m => m.at === sms.at && m.text === sms.text)) list.push(sms);
}

/** '2026-10-21T18:03:34Z' -> '21/10 21:03' (ώρα Ελλάδας) */
function fmtDate(iso) {
  if (!iso) return "—";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

function period(hours) {
  if (!hours) return "20 mins";
  return hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
}
