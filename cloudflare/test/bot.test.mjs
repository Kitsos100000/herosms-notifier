// Δοκιμές με ψεύτικο HeroSMS / Telegram / storage. Καμία πραγματική κλήση ή αγορά.
// Εκτέλεση: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { Bot, CHECK_TEXT } from "../src/bot.js";

const KEY = "ot:129:168";
const ENV = { HERO_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "555", WATCH: "ot:129:168" };

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
  w.fetch = async (url, init) => {
    if (url.startsWith("https://hero-sms.com")) {
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
  assert.deepEqual(w.last().reply_markup.keyboard, [[{ text: CHECK_TEXT }]]);
  await w.type("/balance");
  assert.match(w.last().text, /\$16\.09/);
});

test("σφάλματα HeroSMS: μία ειδοποίηση όταν χαλάσει, μία όταν διορθωθεί", async () => {
  const w = world({ heroDown: true });
  for (let i = 0; i < 8; i++) await w.bot.cron();
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].text, /αποτυγχάνει/);
  assert.match(w.sent[0].text, /HTTP_403/);
  w.heroDown = false; w.offer = null;
  await w.bot.cron();
  assert.match(w.last().text, /λειτουργεί ξανά/);
  await w.bot.cron();
  assert.equal(w.sent.length, 2);
});
