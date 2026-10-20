"""HeroSMS -> Telegram availability notifier, με αγορά από το Telegram.

Ελέγχει περιοδικά το HeroSMS και στέλνει μήνυμα στο Telegram όταν ένας αριθμός
(υπηρεσία + χώρα [+ διάρκεια ενοικίασης]) γίνεται διαθέσιμος. Για τις ενοικιάσεις
το μήνυμα έχει κουμπιά αγοράς (1 / 5 / 10 / όλους / άλλος αριθμός), με επιβεβαίωση.

Χρήση:
    python herosms_notifier.py --chat-id   # βρίσκει το chat ID σου
    python herosms_notifier.py --test      # στέλνει δοκιμαστικό μήνυμα
    python herosms_notifier.py --demo      # ψεύτικη ειδοποίηση με κουμπιά, εικονικές αγορές
    python herosms_notifier.py             # τρέχει συνεχώς
    python herosms_notifier.py --once      # ένας έλεγχος (για GitHub Actions)
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERO_URL = "https://hero-sms.com/stubs/handler_api.php"
ENV_FILE = Path(__file__).with_name(".env")
STATE_FILE = Path(__file__).with_name("state.json")
CONFIG_KEYS = ("HERO_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "WATCH", "MAX_PRICE",
               "INTERVAL_SECONDS", "RENOTIFY_MINUTES", "MAX_BUY", "BUY_WINDOW_MINUTES", "LISTEN_SECONDS")
CONFIRM_TTL = 5 * 60          # το κουμπί «Επιβεβαίωση» λήγει μετά από 5 λεπτά
SESSION_MAX = 25 * 60         # μέγιστη διάρκεια αναμονής για κουμπιά σε μία εκτέλεση --once
DEMO_OFFER = (0.13, 300)      # τιμή / ποσότητα για τη λειτουργία --demo
CHECK_TEXT = "🔍 Έλεγχος τώρα"
MENU = {"keyboard": [[{"text": CHECK_TEXT}]], "resize_keyboard": True, "is_persistent": True}


class HeroError(RuntimeError):
    def __init__(self, title, details=""):
        super().__init__(f"{title} {details}".strip())
        self.title = title


def load_config():
    """Ρυθμίσεις από το .env. Οι μεταβλητές περιβάλλοντος (π.χ. GitHub Secrets) έχουν προτεραιότητα."""
    cfg = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    cfg.update({k: os.environ[k] for k in CONFIG_KEYS if os.environ.get(k)})
    return cfg


def http_json(url, data=None, timeout=20):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "herosms-notifier/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------- HeroSMS

def hero(cfg, action, **params):
    """Κλήση στο HeroSMS. Επιστρέφει JSON ή κείμενο. Τα σφάλματα γίνονται HeroError."""
    q = urllib.parse.urlencode({"action": action, "api_key": cfg["HERO_API_KEY"], **params})
    req = urllib.request.Request(f"{HERO_URL}?{q}", headers={"User-Agent": "herosms-notifier/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            err = json.loads(body)
            raise HeroError(err.get("title", f"HTTP_{e.code}"), err.get("details", ""))
        except ValueError:
            raise HeroError(f"HTTP_{e.code}", body[:200])
    try:
        data = json.loads(body)
    except ValueError:
        if body.startswith(("BAD_", "NO_", "ERROR", "WRONG_")):
            raise HeroError(body.strip())
        return body.strip()
    if isinstance(data, dict) and "title" in data and "details" in data:
        raise HeroError(data["title"], data.get("details", ""))
    return data


def get_offer(cfg, service, country, hours=None):
    """Επιστρέφει (τιμή, ποσότητα) ή None αν δεν υπάρχει προσφορά.

    hours=None: συνηθισμένη ενεργοποίηση (20 λεπτά). hours=168: ενοικίαση 7 ημερών.
    """
    if hours:
        data = hero(cfg, "getRentServicesAndCountries", country=country, duration=hours)
        entry = data.get("services", {}).get(service)
        return (float(entry["price"]), int(entry["quantity"])) if entry else None
    data = hero(cfg, "getPrices", service=service, country=country)
    entry = data.get(str(country), {}).get(service) if isinstance(data, dict) else None
    return (float(entry["cost"]), int(entry["count"])) if entry else None


def get_balance(cfg):
    text = hero(cfg, "getBalance")  # "ACCESS_BALANCE:16.0929"
    return float(str(text).split(":")[1])


def buy_rent(cfg, service, country, hours):
    """Αγοράζει (ενοικιάζει) έναν αριθμό. Επιστρέφει dict με number, id, cost, end."""
    d = hero(cfg, "getRentNumber", service=service, country=country, duration=hours)
    if isinstance(d, dict) and "phone" in d:  # μορφή SMS-Activate
        p = d["phone"]
        return {"number": p.get("number"), "id": p.get("id"), "cost": None, "end": p.get("endDate")}
    return {"number": d.get("phoneNumber"), "id": d.get("activationId"),
            "cost": d.get("activationCost"), "end": d.get("activationEndTime")}


_names = {}


def names(service, country):
    """Επιστρέφει (όνομα υπηρεσίας, όνομα χώρας), π.χ. ('Any other', 'Greece'). Αλλιώς τους κωδικούς."""
    if not _names:
        try:
            _names["svc"] = {s["code"]: s["name"] for s in http_json(f"{HERO_URL}?action=getServicesList")["services"]}
            _names["cty"] = {int(k): v["eng"] for k, v in http_json(f"{HERO_URL}?action=getCountries").items()}
        except Exception:
            _names.update(svc={}, cty={})
    return _names["svc"].get(service, service), _names["cty"].get(country, str(country))


def label(key):
    """'ot:129:168' -> 'Any other – Greece – 7 days'"""
    service, country, hours = parse_key(key)
    svc, cty = names(service, country)
    period = (f"{hours // 24} days" if hours % 24 == 0 else f"{hours} hours") if hours else "20 mins"
    return f"{svc} – {cty} – {period}"


def parse_key(key):
    service, country, hours = key.split(":")
    return service, int(country), (int(hours) if hours not in ("", "None") else None)


def watch_list(cfg):
    pairs = []
    for item in cfg["WATCH"].split(","):
        item = item.strip()
        if item:
            parts = [x.strip() for x in item.split(":")]
            hours = int(parts[2]) if len(parts) > 2 else None
            pairs.append((parts[0], int(parts[1]), hours))
    return pairs


# ---------------------------------------------------------------- Telegram

def telegram(cfg, method, http_timeout=20, **params):
    params = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}
    url = f"https://api.telegram.org/bot{cfg['TELEGRAM_BOT_TOKEN']}/{method}"
    return http_json(url, urllib.parse.urlencode(params).encode(), timeout=http_timeout)


def send(cfg, text, buttons=None, **extra):
    params = {"chat_id": cfg["TELEGRAM_CHAT_ID"], "text": text, "disable_web_page_preview": "true", **extra}
    if buttons:
        params["reply_markup"] = {"inline_keyboard": buttons}
    return telegram(cfg, "sendMessage", **params)["result"]


def edit(cfg, message, text, buttons=None):
    params = {"chat_id": message["chat"]["id"], "message_id": message["message_id"], "text": text,
              "disable_web_page_preview": "true"}
    if buttons:
        params["reply_markup"] = {"inline_keyboard": buttons}
    try:
        telegram(cfg, "editMessageText", **params)
    except urllib.error.HTTPError:
        send(cfg, text, buttons)  # π.χ. πολύ παλιό μήνυμα: στέλνει νέο


def buy_buttons(key, qty, demo=False):
    d = "|d" if demo else ""
    row = [{"text": f"🛒 {n}", "callback_data": f"b|{key}|{n}{d}"} for n in (1, 5, 10) if n < qty]
    return [row, [{"text": f"🛒 Όλους ({qty})", "callback_data": f"b|{key}|all{d}"}],
            [{"text": "✏️ Άλλος αριθμός…", "callback_data": f"a|{key}{d}"}]]


def alert(cfg, key, offer, demo=False, title="🔔 Διαθέσιμο στο HeroSMS!"):
    price, qty = offer
    head = "🧪 DEMO – εικονική ειδοποίηση\n" if demo else ""
    text = (f"{head}{title}\n{label(key)}\n"
            f"Ποσότητα: {qty} αριθμοί\nΤιμή: ${price}\nhttps://hero-sms.com")
    buttons = buy_buttons(key, qty, demo) if parse_key(key)[2] else None  # αγορά μόνο για ενοικιάσεις
    send(cfg, text, buttons)


# ---------------------------------------------------------------- αγορά από το Telegram

def load_state():
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    if "sent" not in state:  # παλιά μορφή: {key: χρόνος}
        state = {"sent": state}
    state.setdefault("offset", 0)
    state.setdefault("ask", None)
    return state


def save_state(state):
    STATE_FILE.write_text(json.dumps(state), encoding="utf-8")


def ask_quantity(cfg, state, key, demo):
    state["ask"] = {"key": key, "demo": demo, "at": time.time()}
    send(cfg, f"✏️ Πόσους αριθμούς θέλεις να αγοράσεις;\n{label(key)}\nΓράψε μόνο τον αριθμό, π.χ. 7",
         reply_markup={"force_reply": True})


def prepare(cfg, key, wanted, demo):
    """Δείχνει σύνοψη (πόσοι, κόστος, υπόλοιπο) με κουμπιά Επιβεβαίωση / Ακύρωση."""
    service, country, hours = parse_key(key)
    offer = DEMO_OFFER if demo else get_offer(cfg, service, country, hours)
    if not offer or offer[1] <= 0:
        send(cfg, f"😕 Δεν υπάρχουν πλέον διαθέσιμοι αριθμοί.\n{label(key)}")
        return
    price, qty = offer
    balance = get_balance(cfg)
    affordable = math.floor(balance / price) if price > 0 else qty
    limit = int(cfg["MAX_BUY"]) if cfg.get("MAX_BUY") else None
    n = qty if wanted == "all" else min(int(wanted), qty)
    notes = []
    if wanted != "all" and int(wanted) > qty:
        notes.append(f"Υπάρχουν μόνο {qty} διαθέσιμοι.")
    if n > affordable:
        notes.append(f"Το υπόλοιπο φτάνει για {affordable}.")
        n = affordable
    if limit and n > limit:
        notes.append(f"Όριο MAX_BUY: {limit}.")
        n = limit
    if n <= 0:
        send(cfg, f"💸 Δεν φτάνει το υπόλοιπο (${balance:.2f}) ούτε για έναν αριθμό (${price}).")
        return
    d = "|d" if demo else ""
    text = ("🧪 DEMO – η αγορά θα είναι εικονική\n" if demo else "") + (
        f"🛒 Αγορά {n} αριθμών\n{label(key)}\n"
        f"Τιμή: ~${price} / αριθμό → σύνολο ~${price * n:.2f}\n"
        f"Υπόλοιπο: ${balance:.2f}\n" + ("\n".join(notes) + "\n" if notes else "") +
        "\nΕπιβεβαιώνεις; (λήγει σε 5 λεπτά)")
    send(cfg, text, [[{"text": "✅ Επιβεβαίωση", "callback_data": f"c|{key}|{n}{d}"},
                      {"text": "❌ Ακύρωση", "callback_data": "x"}]])


def execute(cfg, message, key, n, demo):
    service, country, hours = parse_key(key)
    edit(cfg, message, f"⏳ Αγορά {n} αριθμών σε εξέλιξη…\n{label(key)}")
    bought, stop = [], None
    for i in range(n):
        try:
            if demo:
                bought.append({"number": f"30690000{i:04d}", "id": f"demo{i}", "cost": DEMO_OFFER[0], "end": "—"})
            else:
                bought.append(buy_rent(cfg, service, country, hours))
        except HeroError as e:  # π.χ. NO_NUMBERS, NO_BALANCE: σταματά
            stop = str(e)
            break
        except (urllib.error.URLError, OSError) as e:
            stop = f"σύνδεση: {e}"
            break
    total = sum(float(b["cost"]) for b in bought if b.get("cost") is not None)
    head = ("🧪 DEMO – καμία πραγματική αγορά\n" if demo else "") + \
        f"{'✅' if bought else '❌'} Αγοράστηκαν {len(bought)}/{n}\n{label(key)}\n"
    if total:
        head += f"Κόστος: ${total:.2f}\n"
    if stop:
        head += f"Σταμάτησε: {stop}\n"
    edit(cfg, message, head.strip())
    lines = [f"+{b['number']}  (id {b['id']}, λήξη {b['end']})" for b in bought]
    for i in range(0, len(lines), 50):  # το Telegram δέχεται έως 4096 χαρακτήρες ανά μήνυμα
        send(cfg, "📱 Αριθμοί:\n" + "\n".join(lines[i:i + 50]))
    print(f"αγορά {key}: {len(bought)}/{n} {'(demo)' if demo else ''} {stop or ''}")
    # Ρωτάει αμέσως για τους υπόλοιπους.
    try:
        rest = (DEMO_OFFER[0], DEMO_OFFER[1] - len(bought)) if demo else get_offer(cfg, service, country, hours)
    except (urllib.error.URLError, RuntimeError, OSError):
        return
    if rest and rest[1] > 0:
        alert(cfg, key, rest, demo, title=f"📦 Απομένουν {rest[1]} διαθέσιμοι – θέλεις κι άλλους;")
    else:
        send(cfg, f"Δεν απέμειναν άλλοι διαθέσιμοι.\n{label(key)}")


def manual_check(cfg, state):
    """Κουμπί «Έλεγχος τώρα»: αν υπάρχουν αριθμοί ρωτάει με κουμπιά αγοράς, αλλιώς το λέει."""
    for service, country, hours in watch_list(cfg):
        key = f"{service}:{country}:{hours}"
        try:
            offer = get_offer(cfg, service, country, hours)
        except (urllib.error.URLError, RuntimeError, OSError) as e:
            send(cfg, f"⚠️ Σφάλμα στον έλεγχο: {e}\n{label(key)}")
            continue
        if available(cfg, offer):
            alert(cfg, key, offer, title="🔍 Υπάρχουν διαθέσιμοι!")
            state["sent"][key] = time.time()  # να μην ξαναστείλει ο αυτόματος έλεγχος την ίδια ειδοποίηση
        else:
            send(cfg, f"❌ Δεν υπάρχουν διαθέσιμοι τώρα.\n{label(key)}")


def handle(cfg, state, upd):
    """Επεξεργάζεται ένα update του Telegram (πάτημα κουμπιού ή μήνυμα)."""
    me = str(cfg["TELEGRAM_CHAT_ID"])
    cq = upd.get("callback_query")
    if cq:
        msg = cq.get("message") or {}
        if str(msg.get("chat", {}).get("id")) != me:
            return
        try:
            telegram(cfg, "answerCallbackQuery", callback_query_id=cq["id"])
        except urllib.error.URLError:
            pass
        parts = cq.get("data", "").split("|")
        demo = parts[-1] == "d"
        if demo:
            parts = parts[:-1]
        if parts[0] == "b":
            prepare(cfg, parts[1], parts[2], demo)
        elif parts[0] == "a":
            ask_quantity(cfg, state, parts[1], demo)
        elif parts[0] == "c":
            if time.time() - msg.get("date", 0) > CONFIRM_TTL:
                edit(cfg, msg, "⌛ Η επιβεβαίωση έληξε. Πάτα ξανά ένα κουμπί αγοράς.")
            else:
                execute(cfg, msg, parts[1], int(parts[2]), demo)
        elif parts[0] == "x":
            edit(cfg, msg, "❌ Ακυρώθηκε.")
        return
    msg = upd.get("message")
    if not msg or str(msg.get("chat", {}).get("id")) != me:
        return
    text = (msg.get("text") or "").strip()
    if text in (CHECK_TEXT, "/check"):
        state["ask"] = None
        manual_check(cfg, state)
        return
    if text == "/start":
        send(cfg, f"Πάτα «{CHECK_TEXT}» όποτε θες να ελέγξεις τη διαθεσιμότητα.", reply_markup=MENU)
        return
    ask = state.get("ask")
    if ask and text.isdigit() and int(text) > 0 and time.time() - ask["at"] < 30 * 60:
        state["ask"] = None
        prepare(cfg, ask["key"], text, ask["demo"])
    elif ask and text:
        send(cfg, "Γράψε μόνο έναν αριθμό, π.χ. 7")


def poll(cfg, state, wait):
    """Ένας κύκλος getUpdates (long polling έως `wait` δευτ.). Επιστρέφει πόσα updates επεξεργάστηκε."""
    wait = max(0, math.ceil(wait))  # προς τα πάνω: αλλιώς το 0.9 γίνεται 0 και οι κλήσεις γίνονται συνεχόμενες
    updates = telegram(cfg, "getUpdates", http_timeout=wait + 15, offset=state["offset"],
                       timeout=wait)["result"]
    for upd in updates:
        # Πρώτα «καταναλώνεται» το update (και στο Telegram), μετά εκτελείται: έτσι μια αγορά
        # δεν μπορεί να γίνει δύο φορές, ακόμα κι αν το πρόγραμμα κοπεί στη μέση.
        state["offset"] = upd["update_id"] + 1
        save_state(state)
        telegram(cfg, "getUpdates", offset=state["offset"], limit=1, timeout=0)
        try:
            handle(cfg, state, upd)
        except Exception as e:  # ένα λάθος σε ένα κουμπί δεν σταματά το πρόγραμμα
            print(f"σφάλμα στο update {upd['update_id']}: {e}")
            try:
                send(cfg, f"⚠️ Σφάλμα: {e}")
            except Exception:
                pass
        save_state(state)
    return len(updates)


def session(cfg, state, window):
    """Απαντά σε κουμπιά για `window` δευτερόλεπτα από την τελευταία κίνηση (έως SESSION_MAX)."""
    start = time.time()
    deadline = start + window
    while True:
        remaining = min(deadline, start + SESSION_MAX) - time.time()
        try:
            got = poll(cfg, state, max(0, min(25, remaining)))
        except (urllib.error.URLError, OSError) as e:  # στιγμιαίο σφάλμα δικτύου: ξαναδοκιμάζει
            print(f"σφάλμα σύνδεσης Telegram: {e}")
            time.sleep(3)
            got = 0
        if got:
            deadline = max(deadline, time.time() + int(cfg.get("BUY_WINDOW_MINUTES") or 10) * 60)
        elif remaining <= 0:
            return


# ---------------------------------------------------------------- έλεγχος διαθεσιμότητας

def available(cfg, offer):
    max_price = float(cfg["MAX_PRICE"]) if cfg.get("MAX_PRICE") else None
    return offer is not None and offer[1] > 0 and (max_price is None or offer[0] <= max_price)


def check_all(cfg, state):
    """Ένας έλεγχος όλων των στόχων. Επιστρέφει (σφάλματα, αν στάλθηκε νέα ειδοποίηση)."""
    sent = state["sent"]
    errors, alerted = 0, False
    renotify = int(cfg.get("RENOTIFY_MINUTES") or 0) * 60  # 0 = μία φορά ανά διαθεσιμότητα
    for service, country, hours in watch_list(cfg):
        key = f"{service}:{country}:{hours}"
        try:
            offer = get_offer(cfg, service, country, hours)
        except (urllib.error.URLError, RuntimeError, OSError) as e:
            print(f"[{time.strftime('%H:%M:%S')}] σφάλμα {key}: {e}")
            errors += 1
            continue
        ok = available(cfg, offer)
        print(f"[{time.strftime('%H:%M:%S')}] {key}: {offer} -> {'ΔΙΑΘΕΣΙΜΟ' if ok else 'όχι'}")
        if not ok:
            sent[key] = None
            continue
        prev = sent.get(key)
        if prev is None or (renotify and time.time() - prev >= renotify):
            try:
                alert(cfg, key, offer)
                sent[key] = time.time()
                alerted = True
            except (urllib.error.URLError, OSError) as e:
                print(f"σφάλμα Telegram: {e}")
                errors += 1
    return errors, alerted


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # ελληνικά στην κονσόλα των Windows
    cfg = load_config()
    window = int(cfg.get("BUY_WINDOW_MINUTES") or 10) * 60
    if "--chat-id" in sys.argv:
        updates = telegram(cfg, "getUpdates")["result"]
        ids = {u["message"]["chat"]["id"] for u in updates if "message" in u}
        print("Chat ID:", ", ".join(map(str, ids)) or "δεν βρέθηκε - στείλε πρώτα ένα μήνυμα στο bot σου")
        return
    if "--test" in sys.argv:
        send(cfg, f"✅ Το HeroSMS notifier λειτουργεί.\nΠάτα «{CHECK_TEXT}» όποτε θες έλεγχο.", reply_markup=MENU)
        print("Στάλθηκε.")
        return

    state = load_state()
    if "--demo" in sys.argv:
        s, c, h = watch_list(cfg)[0]
        alert(cfg, f"{s}:{c}:{h}", DEMO_OFFER, demo=True)
        session(cfg, state, window)
        save_state(state)
        return

    if "--once" in sys.argv:
        # Ένας έλεγχος (GitHub Actions). Μετά ακούει το Telegram για λίγο (LISTEN_SECONDS),
        # ή για όλο το παράθυρο αγοράς αν στάλθηκε ειδοποίηση. Κάθε πάτημα παρατείνει την αναμονή.
        errors, alerted = check_all(cfg, state)
        save_state(state)
        session(cfg, state, window if alerted else int(cfg.get("LISTEN_SECONDS") or 0))
        save_state(state)
        sys.exit(1 if errors else 0)  # κόκκινο στο GitHub Actions αν κάτι πήγε στραβά

    interval = int(cfg.get("INTERVAL_SECONDS", "60"))
    print(f"Παρακολούθηση {watch_list(cfg)} κάθε {interval}s. Ctrl+C για έξοδο.")
    while True:
        check_all(cfg, state)
        end = time.time() + interval
        while time.time() < end:  # στο μεταξύ απαντά αμέσως στα κουμπιά
            poll(cfg, state, max(0, min(25, end - time.time())))
        save_state(state)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
