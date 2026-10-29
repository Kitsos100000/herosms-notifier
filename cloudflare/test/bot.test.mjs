// Δοκιμές με ψεύτικο HeroSMS / Telegram / storage. Καμία πραγματική κλήση ή αγορά.
// Εκτέλεση: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { Bot, CHECK_TEXT, CLEAN_TEXT } from "../src/bot.js";

const KEY = "ot:129:168";
const ENV = { HERO_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "555", WATCH: "ot:129:168", NO_PACING: "1" };

function world({ offer = [0.13, 300], balance = 16.09, failAfter = null, heroDown = false, env = {} } = {}) {
  const w = { offer, balance, failAfter, heroDown, bought: 0, sent: [], edits: [], alarms: [], clock: 1_800_000_000_000, nextId: 1 };
  const store = new Map();
  w.storage = {
    get: async k => (store.has(k) ? structuredClone(store.get(k)) : undefined),
    put: async (k, v) => { store.set(k, structuredClone(v)); },
    delete: async k => { store.delete(k); },
    setAlarm: async t => { w.alarms.push(t); },
  };
  const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj });
  const text = (s, status = 200) => ({ ok: status < 400, status, text: async () => s });
  w.acts = []; w.otps = {}; w.v1calls = 0; w.finished = []; w.finishErr = {};
  w.fetch = async (url, init) => {
    if (url.startsWith("https://hero-sms.io/api/v1")) {
      w.v1calls++;
      assert.match(init.headers.Authorization, /^ApiKey /);
      assert.notEqual(init.method, "DELETE", "ποτέ ακύρωση (Cancel)");
      const fin = new URL(url).pathname.match(/activations\/([^/]+)\/finish$/);
      if (fin) {
        assert.equal(init.method, "POST");
        const err = w.finishErr[fin[1]] || w.finishErr["*"];
        if (err) return json({ title: err.title, details: "x" }, err.status);
        w.finished.push(fin[1]);
        return text("", 204);
      }
      const u = new URL(url);
      const size = Number(u.searchParams.get("size")), page = Number(u.searchParams.get("page"));
      if (size > 25) return json({ title: "Unprocessable entity!", details: "size" }, 422);
      const m = u.pathname.match(/activations\/(\d+)\/otp$/);
      const all = m ? (w.otps[m[1]] || []) : w.acts;
      const data = all.slice((page - 1) * size, page * size);
      return json({ data, meta: { page, size, total: all.length } }); // το πραγματικό API δεν στέλνει hasMore εδώ
    }
    if (url.startsWith("https://hero-sms.io")) {
      if (w.heroDown) return text("<html>challenge</html>", 403);
      const p = new URL(url).searchParams;
      const action = p.get("action");
      if (action === "getRentServicesAndCountries") return json({ services: w.offer ? { ot: { price: w.offer[0], quantity: w.offer[1] } } : {} });
      if (action === "getBalance") return text(`ACCESS_BALANCE:${w.balance}`);
      if (action === "getServicesList") return json({ status: "success", services: [{ code: "ot", name: "Any other" }] });
      if (action === "getCountries") return json({ 129: { id: 129, eng: "Greece" } });
      if (action === "getRentNumber") {
        if (w.failAfter !== null && w.bought >= w.failAfter) return json({ title: "NO_NUMBERS", details: "Numbers Gone" }, 404);
        w.bought++;
        if (w.offer) w.offer = [w.offer[0], w.offer[1] - 1];
        return json({ phoneNumber: `3069${String(w.bought).padStart(8, "0")}`, activationId: w.bought, activationCost: 0.13, activationEndTime: "2026-10-27" });
      }
      throw new Error("unexpected hero action " + action);
    }
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "sendMessage") { w.sent.push(body); return json({ ok: true, result: { message_id: w.sent.length, chat: { id: 555 }, date: w.clock / 1000 } }); }
    if (method === "editMessageText") { w.edits.push(body); return json({ ok: true, result: true }); }
    if (method === "answerCallbackQuery") return json({ ok: true, result: true });
    throw new Error("unexpected telegram " + method);
  };
  w.bot = new Bot(w.storage, { ...ENV, ...env }, w.fetch, () => w.clock);
  w.press = (data, { chat = 555, age = 0 } = {}) => w.bot.handleUpdate({ update_id: w.nextId++,
    callback_query: { id: "q", data, message: { message_id: 99, chat: { id: chat }, date: w.clock / 1000 - age } } });
  w.type = (t, chat = 555) => w.bot.handleUpdate({ update_id: w.nextId++, message: { chat: { id: chat }, text: t } });
  w.runAlarms = async () => { let guard = 0; while (w.alarms.length && guard++ < 100) { w.alarms.shift(); await w.bot.alarm(); } };
  w.last = () => w.sent[w.sent.length - 1];
  w.buttons = m => m.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  return w;
}

test("cron: ειδοποίηση με κουμπιά, μία φορά", async () => {
  const w = world();
  await w.bot.cron();
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].text, /Any other – Greece – 7 days/);
  assert.match(w.sent[0].text, /Ποσότητα: 300/);
  assert.deepEqual(w.buttons(w.sent[0]), [`b|${KEY}|1`, `b|${KEY}|5`, `b|${KEY}|10`, `b|${KEY}|all`, `a|${KEY}`]);
  await w.bot.cron();
  assert.equal(w.sent.length, 1, "όχι διπλή ειδοποίηση");
  w.offer = null; await w.bot.cron();
  w.offer = [0.2, 3]; await w.bot.cron();
  assert.equal(w.sent.length, 2, "ξαναστέλνει όταν ξαναεμφανιστεί");
  assert.deepEqual(w.buttons(w.last()), [`b|${KEY}|1`, `b|${KEY}|all`, `a|${KEY}`]);
});

test("αγορά 5: επιβεβαίωση, αγορά, ερώτηση για τους υπόλοιπους", async () => {
  const w = world();
  await w.press(`b|${KEY}|5`);
  assert.equal(w.bought, 0);
  assert.match(w.last().text, /Αγορά 5 αριθμών/);
  assert.match(w.last().text, /σύνολο ~\$0\.65/);
  assert.deepEqual(w.buttons(w.last()), [`c|${KEY}|5`, "x"]);
  await w.press(`c|${KEY}|5`);
  assert.equal(w.bought, 0, "η αγορά γίνεται στο alarm");
  assert.match(w.edits.at(-1).text, /σε εξέλιξη… 0\/5/);
  await w.runAlarms();
  assert.equal(w.bought, 5);
  assert.match(w.edits.at(-1).text, /Αγοράστηκαν 5\/5/);
  assert.match(w.edits.at(-1).text, /Κόστος: \$0\.65/);
  assert.equal((w.sent.at(-2).text.match(/\+3069/g) || []).length, 5);
  assert.match(w.last().text, /Απομένουν 295/);
  assert.equal(await w.storage.get("job"), undefined);
});

test("μεγάλη αγορά σε παρτίδες των 20", async () => {
  const w = world({ balance: 100 });
  await w.press(`c|${KEY}|48`);
  await w.bot.alarm(); w.alarms.shift();
  assert.equal(w.bought, 20);
  assert.match(w.edits.at(-1).text, /20\/48/);
  assert.equal(w.alarms.length, 1, "προγραμματίζει την επόμενη παρτίδα");
  await w.runAlarms();
  assert.equal(w.bought, 48);
  assert.match(w.edits.at(-1).text, /Αγοράστηκαν 48\/48/);
});

test("αν κοπεί στη μέση, δεν ξαναγοράζει όσα ήδη πήρε", async () => {
  const w = world();
  await w.press(`c|${KEY}|30`);
  const realPut = w.storage.put;
  let puts = 0;
  w.storage.put = async (k, v) => { if (k === "job" && ++puts === 6) throw new Error("crash"); return realPut(k, v); };
  await assert.rejects(w.bot.alarm());        // κόπηκε μετά από 6 αγορές (η 6η δεν αποθηκεύτηκε)
  w.storage.put = realPut;
  await w.bot.alarm(); await w.runAlarms();     // το Cloudflare ξανατρέχει το alarm
  const job = w.edits.at(-1).text;
  assert.match(job, /Αγοράστηκαν 30\/30/);
  assert.ok(w.bought <= 31, `το πολύ 1 επιπλέον αγορά λόγω της διακοπής (έγιναν ${w.bought})`);
});

test("«Όλους» περιορίζεται από υπόλοιπο και MAX_BUY", async () => {
  let w = world({ balance: 1.0 });
  await w.press(`b|${KEY}|all`);
  assert.match(w.last().text, /Αγορά 7 αριθμών/);
  assert.match(w.last().text, /φτάνει για 7/);
  w = world({ env: { MAX_BUY: "20" } });
  await w.press(`b|${KEY}|all`);
  assert.match(w.last().text, /Αγορά 20 αριθμών/);
  w = world({ balance: 0.05 });
  await w.press(`b|${KEY}|all`);
  assert.match(w.last().text, /Δεν φτάνει το υπόλοιπο/);
});

test("Άλλος αριθμός: ρωτάει, δέχεται μόνο αριθμό", async () => {
  const w = world();
  await w.press(`a|${KEY}`);
  assert.match(w.last().text, /Πόσους/);
  assert.equal(w.last().reply_markup.force_reply, true);
  await w.type("abc");
  assert.match(w.last().text, /μόνο έναν αριθμό/);
  await w.type("3");
  assert.match(w.last().text, /Αγορά 3 αριθμών/);
  await w.type("4");
  assert.match(w.last().text, /Αγορά 3 αριθμών/, "αριθμός αργότερα αγνοείται");
});

test("εξαντλούνται στη μέση", async () => {
  const w = world({ failAfter: 2 });
  await w.press(`c|${KEY}|5`);
  await w.runAlarms();
  assert.equal(w.bought, 2);
  assert.match(w.edits.at(-1).text, /2\/5/);
  assert.match(w.edits.at(-1).text, /NO_NUMBERS/);
});

test("ασφάλεια: λήξη, ξένο chat, διπλό update, αγορά σε εξέλιξη", async () => {
  let w = world();
  await w.press(`c|${KEY}|5`, { age: 400 });
  await w.runAlarms();
  assert.equal(w.bought, 0);
  assert.match(w.edits.at(-1).text, /έληξε/);

  w = world();
  await w.press(`c|${KEY}|5`, { chat: 777 });
  await w.type("🔍 Έλεγχος τώρα", 777);
  await w.runAlarms();
  assert.equal(w.bought, 0);
  assert.equal(w.sent.length + w.edits.length, 0);

  w = world();
  const upd = { update_id: 5, callback_query: { id: "q", data: `c|${KEY}|2`, message: { message_id: 1, chat: { id: 555 }, date: w.clock / 1000 } } };
  await w.bot.handleUpdate(upd);
  await w.bot.handleUpdate(upd); // το Telegram το ξαναστέλνει
  await w.runAlarms();
  assert.equal(w.bought, 2, "δεν αγοράζει δύο φορές");

  w = world();
  await w.press(`c|${KEY}|5`);
  await w.press(`c|${KEY}|5`);
  assert.match(w.last().text, /ήδη αγορά σε εξέλιξη/);
  await w.runAlarms();
  assert.equal(w.bought, 5);
});

test("demo: εικονικές αγορές", async () => {
  const w = world({ offer: null });
  await w.type("/demo");
  assert.match(w.last().text, /DEMO/);
  assert.ok(w.buttons(w.last()).every(d => d.endsWith("|d")));
  await w.press(`b|${KEY}|all|d`);
  assert.match(w.last().text, /DEMO – η αγορά θα είναι εικονική/);
  await w.press(`c|${KEY}|10|d`);
  await w.runAlarms();
  assert.equal(w.bought, 0);
  assert.match(w.edits.at(-1).text, /DEMO – καμία πραγματική αγορά/);
  assert.match(w.edits.at(-1).text, /10\/10/);
  assert.match(w.last().text, /Απομένουν 290/);
});

test("Έλεγχος τώρα, /start, /balance", async () => {
  let w = world();
  await w.type(CHECK_TEXT);
  assert.match(w.last().text, /Υπάρχουν διαθέσιμοι/);
  await w.bot.cron();
  assert.equal(w.sent.length, 1, "ο αυτόματος έλεγχος δεν επαναλαμβάνει");
  w = world({ offer: null });
  await w.type("/check");
  assert.match(w.last().text, /Δεν υπάρχουν διαθέσιμοι τώρα/);
  await w.type("/start");
  assert.deepEqual(w.last().reply_markup, { remove_keyboard: true }, "χωρίς κουμπιά, μόνο Menu");
  await w.type("/balance");
  assert.match(w.last().text, /\$16\.09/);
});

test("σφάλματα HeroSMS: μία ειδοποίηση όταν χαλάσει, μία όταν διορθωθεί", async () => {
  const w = world({ heroDown: true });
  for (let i = 0; i < 8; i++) await w.bot.cron();
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].text, /αποτυγχάνει/);
  assert.match(w.sent[0].text, /HTTP_403 \(σελίδα HTML/);
  w.heroDown = false; w.offer = null;
  await w.bot.cron();
  assert.match(w.last().text, /λειτουργεί ξανά/);
  await w.bot.cron();
  assert.equal(w.sent.length, 2);
});

// ------------------------------------------------------------ /list και /scan

/** n ενεργοί αριθμοί, ο πρώτος ο νεότερος (όπως τους δίνει το API). */
function makeActs(w, n) {
  const base = Date.UTC(2026, 9, 21, 18, 0, 0);
  w.clock = Date.UTC(2026, 9, 21, 19, 0, 0);
  for (let i = 0; i < n; i++) {
    const created = new Date(base - i * 60_000);
    w.acts.push({ id: 1000 + n - i, status: 4, phone: 306900000000 + i, service: "ot", country: 129,
      createdAt: created.toISOString(), expiredAt: new Date(created.getTime() + 7 * 86400_000).toISOString(),
      otpLast: null, otpTotalCount: 0 });
  }
}
const sms = (from, text, at, code = null) => ({ id: "s" + Math.random(), phoneFrom: from, smsText: text, smsCode: code, receivedAt: at, type: "sms", service: "ot" });

test("/list: όλες οι σελίδες, νεότερος → παλαιότερος, χωρίς ληγμένους", async () => {
  const w = world();
  w.clock = Date.UTC(2026, 9, 21, 19, 0, 0);
  makeActs(w, 60);
  w.acts[5].expiredAt = "2026-10-20T00:00:00.000000Z"; // ληγμένος
  w.acts[2].otpTotalCount = 2;
  await w.type("/list");
  assert.match(w.sent[0].text, /Διαβάζω/);
  await w.runAlarms();
  const out = w.sent.slice(1).map(m => m.text).join("\n");
  assert.match(out, /Ενεργοί αριθμοί: 59/);
  const phones = [...out.matchAll(/\+(\d+)/g)].map(m => m[1]);
  assert.equal(phones.length, 59);
  assert.equal(phones[0], "306900000000", "πρώτος ο νεότερος");
  assert.equal(phones.at(-1), "306900000059", "τελευταίος ο παλαιότερος");
  assert.ok(!phones.includes("306900000005"), "χωρίς τον ληγμένο");
  assert.match(out, /\+306900000002 · 21\/10 20:58 → 28\/10 19:58 · 📩 2/, "ώρα Ελλάδας (UTC+3, χειμερινή UTC+2 μετά τις 25/10)");
  assert.equal(await w.storage.get("report"), undefined);
});

test("/list: πολλοί αριθμοί -> πολλά βήματα και πολλά μηνύματα", async () => {
  const w = world();
  w.clock = Date.UTC(2026, 9, 21, 19, 0, 0);
  makeActs(w, 1000); // 40 σελίδες > 35 κλήσεις ανά βήμα
  await w.type("/list");
  await w.bot.alarm(); w.alarms.shift();
  assert.equal(w.v1calls, 35, "σταματά στο όριο ανά βήμα");
  await w.runAlarms();
  assert.equal(w.v1calls, 40);
  const msgs = w.sent.slice(1);
  assert.ok(msgs.length > 5 && msgs.every(m => m.text.length <= 4096), "χωρίζεται σε μηνύματα ≤ 4096");
  assert.equal([...msgs.map(m => m.text).join("\n").matchAll(/\+\d+/g)].length, 1000);
});

test("/scan: βρίσκει PREDICT2WIN σε τελευταίο SMS και σε παλαιότερα", async () => {
  const w = world();
  w.clock = Date.UTC(2026, 9, 21, 19, 0, 0);
  makeActs(w, 30);
  const set = (i, last, all) => { w.acts[i].otpLast = last; w.acts[i].otpTotalCount = all ? all.length : 1; if (all) w.otps[w.acts[i].id] = all; };
  set(1, sms("PREDICT2WIN", "Your code 1111", "2026-10-21T18:10:00Z", "1111"));
  set(3, sms("Frog", "frog msg", "2026-10-21T18:20:00Z"));
  set(4, sms("Frog", "frog", "2026-10-21T18:30:00Z"),            // τελευταίο Frog, παλαιότερο PREDICT2WIN
    [sms("Predict2Win", "Welcome to Predict2Win", "2026-10-21T18:25:00Z"), sms("Frog", "frog", "2026-10-21T18:30:00Z")]);
  set(7, sms("NOVA", "x", "2026-10-21T18:05:00Z"));
  set(8, sms("PREDICT2WIN", "code 2222", "2026-10-21T18:40:00Z", "2222"),
    [sms("PREDICT2WIN", "code 0000", "2026-10-21T18:01:00Z", "0000"), sms("PREDICT2WIN", "code 2222", "2026-10-21T18:40:00Z", "2222")]);
  await w.type("/scan");
  assert.match(w.sent[0].text, /Σαρώνω.*PREDICT2WIN/);
  await w.runAlarms();
  const out = w.last().text;
  assert.match(out, /SMS από «PREDICT2WIN»: 3 αριθμοί/);
  assert.match(out, /5 με SMS/);
  const order = [...out.matchAll(/\+(\d+)/g)].map(m => m[1]);
  assert.deepEqual(order, ["306900000008", "306900000004", "306900000001"], "νεότερο SMS πρώτα");
  assert.match(out, /\+306900000008 · 2 SMS\n🕒 21\/10 21:40\n🔑 Κωδικός: 2222\ncode 2222\n\n🕒 21\/10 21:01\n🔑 Κωδικός: 0000\ncode 0000/,
    "όλα τα SMS του αποστολέα, ολόκληρα, νεότερο πρώτο");
  assert.match(out, /\+306900000004\n🕒 21\/10 21:25\nWelcome to Predict2Win/);
  assert.ok(!/frog/.test(out), "όχι μηνύματα άλλων αποστολέων");
  assert.equal(w.v1calls, 2 + 2, "2 σελίδες + 2 αριθμοί με πολλά SMS");
});

test("/scan: άλλος αποστολέας και κανένα αποτέλεσμα", async () => {
  const w = world();
  makeActs(w, 3);
  w.acts[0].otpLast = sms("Frog", "hi", "2026-10-21T18:10:00Z"); w.acts[0].otpTotalCount = 1;
  await w.type("/scan frog");
  await w.runAlarms();
  assert.match(w.last().text, /«frog»: 1 αριθμοί/);
  await w.type("/scan");
  await w.runAlarms();
  assert.match(w.last().text, /Κανένας αριθμός δεν έχει λάβει SMS από «PREDICT2WIN»/);
});

test("/list και /scan: σφάλμα, διπλή εντολή, συνύπαρξη με αγορά", async () => {
  let w = world({ heroDown: true });
  makeActs(w, 3);
  const realFetch = w.fetch;
  w.bot.fetch = async (url, init) => url.includes("/api/v1") ? { ok: false, status: 403, text: async () => "<html>" } : realFetch(url, init);
  await w.type("/list");
  await w.runAlarms();
  assert.match(w.last().text, /Σφάλμα στο \/list: HTTP_403/);
  assert.equal(await w.storage.get("report"), undefined);

  w = world();
  makeActs(w, 3);
  await w.type("/list");
  await w.type("/scan");
  assert.match(w.last().text, /ήδη λίστα\/σάρωση/);

  w = world();
  makeActs(w, 3);
  await w.press(`c|${KEY}|5`);
  await w.type("/list");
  await w.runAlarms();
  assert.equal(w.bought, 5);
  assert.ok(w.sent.some(m => /Ενεργοί αριθμοί: 3/.test(m.text)));
  assert.equal(await w.storage.get("job"), undefined);
  assert.equal(await w.storage.get("report"), undefined);
});

test("Καθαρή λίστα: μόνο 69xxxxxxxx, νεότερος → παλαιότερος, χωρίς τίποτα άλλο", async () => {
  const w = world();
  makeActs(w, 600); // > 1 μήνυμα
  w.acts[3].expiredAt = "2026-10-20T00:00:00.000000Z";
  await w.type("/start");
  assert.deepEqual(w.last().reply_markup, { remove_keyboard: true }, "χωρίς κουμπιά, μόνο Menu");
  const before = w.sent.length;
  await w.type(CLEAN_TEXT);
  assert.equal(w.sent.length, before, "κανένα μήνυμα «περίμενε»");
  await w.runAlarms();
  const msgs = w.sent.slice(before).map(m => m.text);
  assert.ok(msgs.length >= 2 && msgs.every(m => m.length <= 4096));
  const lines = msgs.join("\n").split("\n");
  assert.equal(lines.length, 599);
  assert.ok(lines.every(l => /^69\d{8}$/.test(l)), "μόνο αριθμοί 69xxxxxxxx");
  assert.equal(lines[0], "6900000000");
  assert.equal(lines.at(-1), "6900000599");
  assert.ok(!lines.includes("6900000003"), "χωρίς τον ληγμένο");
  await w.type("/clean");
  await w.runAlarms();
  assert.equal(w.last().text.split("\n").at(-1), "6900000599");
});

// ------------------------------------------------------------ /complete

import { parsePositions } from "../src/bot.js";

/** /list -> snapshot. Επιστρέφει τον κωδικό του /complete. */
async function listThenComplete(w, spec) {
  await w.type("/clean");
  await w.runAlarms();
  await w.type(`/complete ${spec}`);
  const p = await w.storage.get("finPending");
  return p?.code;
}
const idAt = (w, pos) => String(w.acts[pos - 1].id); // θέση στη λίστα (1 = νεότερος)

test("parsePositions: αυστηρή μορφή", () => {
  assert.deepEqual(parsePositions("350-400", 500).positions.length, 51);
  assert.deepEqual(parsePositions("1-3,7, 10-12", 20).positions, [1, 2, 3, 7, 10, 11, 12]);
  assert.deepEqual(parsePositions("5,5,4-6", 9).positions, [4, 5, 6]);
  assert.deepEqual(parsePositions("350–400", 500).positions.length, 51, "δέχεται και en dash");
  assert.deepEqual(parsePositions(" 350 - 400 , 410 ", 500).positions.length, 52, "κενά γύρω από - και ,");
  for (const bad of ["", "abc", "350-", "-5", "1-2-3", "5;6", "1.5", "350 400", "1 2", "1-3 7", "0", "0-3"]) {
    assert.ok(parsePositions(bad, 500).error, `απορρίπτεται: «${bad}»`);
  }
  assert.match(parsePositions("400-350", 500).error, /μεγαλύτερη/);
  assert.match(parsePositions("490-501", 500).error, /501 δεν υπάρχει/);
});

test("/complete 350-400: σύνοψη, κωδικός, ολοκληρώνει ακριβώς τις 51 θέσεις", async () => {
  const w = world();
  makeActs(w, 500);
  const code = await listThenComplete(w, "350-400");
  assert.ok(code >= 1000 && code <= 9999);
  assert.equal(w.finished.length, 0, "τίποτα πριν την επιβεβαίωση");
  const summary = w.sent.filter(m => /COMPLETE ACTIVATION/.test(m.text)).map(m => m.text).join("\n");
  assert.match(summary, /ΜΗ ΑΝΑΣΤΡΕΨΙΜΟ/);
  assert.match(summary, /Σύνολο: 51 αριθμοί/);
  assert.match(summary, /Πρώτος: #350 6900000349/);
  assert.match(summary, /Τελευταίος: #400 6900000399/);
  const all = w.sent.map(m => m.text).join("\n");
  assert.equal([...all.matchAll(/^#\d+ 69/gm)].length, 51, "όλοι οι 51 στη λίστα");
  assert.match(w.last().text, new RegExp(`/confirm ${code}`));
  assert.deepEqual(w.buttons(w.last()), ["xf"]);
  await w.type(`/confirm ${code}`);
  await w.runAlarms();
  const expected = Array.from({ length: 51 }, (_, i) => idAt(w, 350 + i));
  assert.deepEqual(w.finished, expected, "ακριβώς οι θέσεις 350..400, μία φορά η καθεμία");
  assert.match(w.edits.at(-1).text, /✅ Complete activation: 51\/51/);
  assert.equal(await w.storage.get("fin"), undefined);
  assert.equal(await w.storage.get("snapshot"), undefined, "χρειάζεται νέο /list");
  await w.type(`/confirm ${code}`);
  assert.match(w.last().text, /Δεν υπάρχει εκκρεμές/);
  await w.type("/complete 1-2");
  assert.match(w.last().text, /Γράψε πρώτα \/list/);
  await w.runAlarms();
  assert.equal(w.finished.length, 51, "τίποτα παραπάνω");
});

test("/complete: νέα αγορά μετά το /list δεν μετακινεί τις θέσεις", async () => {
  const w = world();
  makeActs(w, 20);
  await w.type("/list"); await w.runAlarms();
  const want = [idAt(w, 3), idAt(w, 4)];
  w.acts.unshift({ ...w.acts[0], id: 99999, phone: 306999999999, createdAt: "2026-10-21T18:59:00.000Z" }); // νέος, πρώτος πλέον
  await w.type("/complete 3-4");
  const { code } = await w.storage.get("finPending");
  await w.type(`/confirm ${code}`);
  await w.runAlarms();
  assert.deepEqual(w.finished, want);
});

test("/complete: λάθος/ληγμένος κωδικός, ακύρωση, παλιά λίστα, θέσεις εκτός, ξένο chat", async () => {
  let w = world(); makeActs(w, 10);
  let code = await listThenComplete(w, "1-3");
  await w.type(`/confirm ${code === 9999 ? 1000 : code + 1}`);
  assert.match(w.last().text, /Λάθος κωδικός/);
  await w.type(`/confirm ${code}`);
  assert.match(w.last().text, /Δεν υπάρχει εκκρεμές/, "μετά από λάθος κωδικό ακυρώνεται");
  await w.runAlarms();
  assert.equal(w.finished.length, 0);

  w = world(); makeActs(w, 10);
  code = await listThenComplete(w, "1-3");
  w.clock += 6 * 60_000;
  await w.type(`/confirm ${code}`);
  assert.match(w.last().text, /έληξε/);
  await w.runAlarms();
  assert.equal(w.finished.length, 0);

  w = world(); makeActs(w, 10);
  code = await listThenComplete(w, "1-3");
  await w.press("xf");
  assert.match(w.edits.at(-1).text, /Ακυρώθηκε/);
  await w.type(`/confirm ${code}`);
  await w.runAlarms();
  assert.equal(w.finished.length, 0);

  w = world(); makeActs(w, 10);
  await w.type("/complete 1-3");
  assert.match(w.last().text, /Γράψε πρώτα \/list/, "χωρίς λίστα");
  await w.type("/list"); await w.runAlarms();
  w.clock += 61 * 60_000;
  await w.type("/complete 1-3");
  assert.match(w.last().text, /Γράψε πρώτα \/list/, "παλιά λίστα");

  w = world(); makeActs(w, 10);
  await w.type("/list"); await w.runAlarms();
  await w.type("/complete 5-11");
  assert.match(w.last().text, /11 δεν υπάρχει/);
  await w.type("/complete 350 400");
  assert.match(w.last().text, /Μη έγκυρη μορφή/);
  await w.type("/complete");
  assert.match(w.last().text, /Γράψε τις θέσεις/);
  assert.equal(await w.storage.get("finPending"), undefined);

  w = world(); makeActs(w, 10);
  code = await listThenComplete(w, "1-3");
  await w.type(`/confirm ${code}`, 777); // ξένο chat
  await w.runAlarms();
  assert.equal(w.finished.length, 0);
});

test("/complete: σφάλμα ενός αριθμού -> συνεχίζει, γενικό σφάλμα -> σταματά", async () => {
  let w = world(); makeActs(w, 10);
  w.finishErr[idAt(w, 2)] = { status: 409, title: "NEW_OTP_RECEIVED" };
  let code = await listThenComplete(w, "1-4");
  await w.type(`/confirm ${code}`);
  await w.runAlarms();
  assert.deepEqual(w.finished, [idAt(w, 1), idAt(w, 3), idAt(w, 4)]);
  assert.match(w.edits.at(-1).text, /3\/4 ολοκληρώθηκαν/);
  assert.match(w.last().text, /❌ #2 6900000001 – NEW_OTP_RECEIVED/);

  w = world(); makeActs(w, 10);
  code = await listThenComplete(w, "1-5");
  await w.type(`/confirm ${code}`);
  const realFinished = w.finished;
  w.bot.fetch = async (url, init) => {
    if (url.includes("/finish") && realFinished.length === 2) return { ok: false, status: 503, text: async () => "<html>down</html>" };
    return w.fetch(url, init);
  };
  await w.runAlarms();
  assert.equal(w.finished.length, 2);
  assert.match(w.edits.at(-1).text, /2\/5 ολοκληρώθηκαν/);
  assert.match(w.edits.at(-1).text, /Σταμάτησε: HTTP_503/);
  assert.match(w.last().text, /⏸ #3 .* δεν έγινε/);
});

test("/complete: πολλοί αριθμοί σε βήματα, διπλό update δεν ξανατρέχει", async () => {
  const w = world(); makeActs(w, 120);
  await w.type("/list"); await w.runAlarms();
  await w.type("/complete 1-100");
  const { code } = await w.storage.get("finPending");
  const upd = { update_id: 777, message: { chat: { id: 555 }, text: `/confirm ${code}` } };
  await w.bot.handleUpdate(upd);
  await w.bot.handleUpdate(upd);
  await w.bot.alarm(); w.alarms.shift();
  assert.equal(w.finished.length, 35, "όριο ανά βήμα");
  await w.runAlarms();
  assert.equal(w.finished.length, 100);
  assert.equal(new Set(w.finished).size, 100, "καμία διπλή ολοκλήρωση");
});


test("/scan: ολόκληρο μεγάλο μήνυμα, με αλλαγές γραμμής και χωρίς HTML entities", async () => {
  const w = world();
  makeActs(w, 2);
  const long = "ΣYΓXAPHTHPIA! &#10;EIΣAI ENAΣ AΠO TOYΣ MEΓAΛOYΣ NIKHTEΣ TOY ΠPOBΛEΠEIΣ &#38; KEPΔIZEIΣ AΠO TO ΠAME ΣTOIXHMA KAI KEPΔIΣEΣ 1 Public Voucher AΞIAΣ 50€! &#10;EΠIKOINΩNHΣE ME TO TMHMA ΔΩPΩN THΣ ALLWYN ΣTO 210 9525255, KAΘHMEPINA 11:00 ME 15:00, EΩΣ 23/10/2026.";
  w.acts[0].otpLast = { ...sms("PREDICT2WIN", null, "2026-10-21T11:30:00Z"), smsCode: long }; // όπως το HeroSMS: όλο το μήνυμα στο code
  w.acts[0].otpTotalCount = 1;
  await w.type("/scan");
  await w.runAlarms();
  const out = w.last().text;
  assert.ok(out.includes("ΣYΓXAPHTHPIA!\nEIΣAI ENAΣ"), "αλλαγή γραμμής αντί για &#10;");
  assert.ok(out.includes("ΠPOBΛEΠEIΣ & KEPΔIZEIΣ"), "& αντί για &#38;");
  assert.ok(out.includes("EΩΣ 23/10/2026."), "ολόκληρο, ως το τέλος");
  assert.ok(!out.includes("…") && !out.includes("&#"), "χωρίς κόψιμο και entities");
  assert.ok(!out.includes("🔑"), "όχι «κωδικός» όταν το code είναι όλο το μήνυμα");
});
