"""HeroSMS -> Telegram availability notifier.

Ελέγχει περιοδικά το HeroSMS και στέλνει μήνυμα στο Telegram όταν ένας αριθμός
(υπηρεσία + χώρα) γίνεται διαθέσιμος (και, προαιρετικά, κάτω από μέγιστη τιμή).

Χρήση:
    python herosms_notifier.py --chat-id   # βρίσκει το chat ID σου
    python herosms_notifier.py --test      # στέλνει δοκιμαστικό μήνυμα
    python herosms_notifier.py             # τρέχει συνεχώς
    python herosms_notifier.py --once      # ένας έλεγχος (για GitHub Actions)
"""
import json
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
CONFIG_KEYS = ("HERO_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "WATCH",
               "MAX_PRICE", "INTERVAL_SECONDS", "RENOTIFY_MINUTES")


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


def http_json(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "herosms-notifier/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def telegram(token, method, **params):
    url = f"https://api.telegram.org/bot{token}/{method}"
    return http_json(url, urllib.parse.urlencode(params).encode())


def send(cfg, text):
    telegram(cfg["TELEGRAM_BOT_TOKEN"], "sendMessage", chat_id=cfg["TELEGRAM_CHAT_ID"],
             text=text, disable_web_page_preview="true")


def get_offer(cfg, service, country, hours=None):
    """Επιστρέφει (cost, count) ή None αν δεν υπάρχει προσφορά.

    hours=None: συνηθισμένη ενεργοποίηση (20 λεπτά). hours=168: ενοικίαση 7 ημερών.
    """
    if hours:
        q = urllib.parse.urlencode({"action": "getRentServicesAndCountries", "api_key": cfg["HERO_API_KEY"],
                                    "country": country, "duration": hours})
        data = http_json(f"{HERO_URL}?{q}")
        if not isinstance(data, dict) or "title" in data:
            raise RuntimeError(f"Σφάλμα HeroSMS: {data}")
        entry = data.get("services", {}).get(service)
        return (float(entry["price"]), int(entry["quantity"])) if entry else None
    q = urllib.parse.urlencode({"action": "getPrices", "api_key": cfg["HERO_API_KEY"],
                                "service": service, "country": country})
    try:
        data = http_json(f"{HERO_URL}?{q}")
    except json.JSONDecodeError:
        raise RuntimeError("Μη έγκυρη απάντηση από HeroSMS (πιθανώς λάθος API key)")
    if not isinstance(data, dict) or "title" in data:
        raise RuntimeError(f"Σφάλμα HeroSMS: {data}")
    entry = data.get(str(country), {}).get(service)
    if not entry:
        return None
    return float(entry["cost"]), int(entry["count"])


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


def watch_list(cfg):
    pairs = []
    for item in cfg["WATCH"].split(","):
        item = item.strip()
        if item:
            parts = [x.strip() for x in item.split(":")]
            hours = int(parts[2]) if len(parts) > 2 else None
            pairs.append((parts[0], int(parts[1]), hours))
    return pairs


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # ελληνικά στην κονσόλα των Windows
    cfg = load_config()
    if "--chat-id" in sys.argv:
        updates = telegram(cfg["TELEGRAM_BOT_TOKEN"], "getUpdates")["result"]
        ids = {u["message"]["chat"]["id"] for u in updates if "message" in u}
        print("Chat ID:", ", ".join(map(str, ids)) or "δεν βρέθηκε - στείλε πρώτα ένα μήνυμα στο bot σου")
        return
    if "--test" in sys.argv:
        send(cfg, "✅ Το HeroSMS notifier λειτουργεί.")
        print("Στάλθηκε.")
        return

    if "--once" in sys.argv:
        # Ένας έλεγχος και έξοδος (GitHub Actions). Η κατάσταση μένει σε αρχείο μεταξύ των εκτελέσεων.
        try:
            last_sent = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            last_sent = {}
        check_all(cfg, last_sent)
        STATE_FILE.write_text(json.dumps(last_sent), encoding="utf-8")
        return

    interval = int(cfg.get("INTERVAL_SECONDS", "60"))
    last_sent = {}
    print(f"Παρακολούθηση {watch_list(cfg)} κάθε {interval}s. Ctrl+C για έξοδο.")
    while True:
        check_all(cfg, last_sent)
        time.sleep(interval)


def check_all(cfg, last_sent):
    """Ένας έλεγχος όλων των στόχων. last_sent: 'service:country:hours' -> χρόνος ειδοποίησης ή None."""
    max_price = float(cfg["MAX_PRICE"]) if cfg.get("MAX_PRICE") else None
    renotify = int(cfg.get("RENOTIFY_MINUTES") or 0) * 60  # 0 = μία φορά ανά διαθεσιμότητα
    for service, country, hours in watch_list(cfg):
        key = f"{service}:{country}:{hours}"
        try:
            offer = get_offer(cfg, service, country, hours)
        except (urllib.error.URLError, RuntimeError, OSError) as e:
            print(f"[{time.strftime('%H:%M:%S')}] σφάλμα {key}: {e}")
            continue
        ok = offer is not None and offer[1] > 0 and (max_price is None or offer[0] <= max_price)
        print(f"[{time.strftime('%H:%M:%S')}] {key}: {offer} -> {'ΔΙΑΘΕΣΙΜΟ' if ok else 'όχι'}")
        if not ok:
            last_sent[key] = None
            continue
        prev = last_sent.get(key)
        if prev is None or (renotify and time.time() - prev >= renotify):
            try:
                svc, cty = names(service, country)
                period = (f"{hours // 24} days" if hours % 24 == 0 else f"{hours} hours") if hours else "20 mins"
                send(cfg, f"🔔 Διαθέσιμο στο HeroSMS!\n{svc} – {cty} – {period}\n"
                          f"Ποσότητα: {offer[1]} αριθμοί\nΤιμή: ${offer[0]}\nhttps://hero-sms.com")
                last_sent[key] = time.time()
            except (urllib.error.URLError, OSError) as e:
                print(f"σφάλμα Telegram: {e}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
