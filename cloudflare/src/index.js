// Cloudflare Worker: δέχεται τα κουμπιά του Telegram (webhook) και ελέγχει το HeroSMS κάθε λεπτό (cron).
// Όλη η κατάσταση ζει σε ένα Durable Object ("main"), ώστε κάθε ενέργεια να γίνεται μία φορά και με τη σειρά.
import { DurableObject } from "cloudflare:workers";
import { Bot } from "./bot.js";

export class BotObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.bot = new Bot(ctx.storage, env);
  }
  update(upd) { return this.bot.handleUpdate(upd); }
  health() { return this.bot.health(); }
  cron() { return this.bot.cron(); }
  alarm() { return this.bot.alarm(); }
}

const bot = env => env.BOT.get(env.BOT.idFromName("main"));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/telegram") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      await bot(env).update(await req.json());
      return new Response("ok");
    }
    if (url.pathname === "/health" && req.headers.get("X-Secret") === env.WEBHOOK_SECRET) {
      return Response.json(await bot(env).health());
    }
    return new Response("HeroSMS notifier");
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(bot(env).cron());
  },
};
