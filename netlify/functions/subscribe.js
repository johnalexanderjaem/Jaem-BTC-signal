// netlify/functions/subscribe.js
// Recibe la suscripción push del navegador (PushSubscription) y la guarda
// en Netlify Blobs para que check-signals.js pueda enviarle notificaciones después.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const store = getStore("jaem-push");

  if (req.method === "POST") {
    try {
      const subscription = await req.json();
      if (!subscription || !subscription.endpoint) {
        return new Response(JSON.stringify({ error: "Suscripción inválida" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const existing = (await store.get("subscriptions", { type: "json" })) || [];
      const filtered = existing.filter((s) => s.endpoint !== subscription.endpoint);
      filtered.push(subscription);
      await store.setJSON("subscriptions", filtered);
      return new Response(JSON.stringify({ ok: true, total: filtered.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("subscribe error:", err);
      return new Response(JSON.stringify({ error: "Error interno" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "DELETE") {
    try {
      const { endpoint } = await req.json();
      const existing = (await store.get("subscriptions", { type: "json" })) || [];
      const filtered = existing.filter((s) => s.endpoint !== endpoint);
      await store.setJSON("subscriptions", filtered);
      return new Response(JSON.stringify({ ok: true, total: filtered.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("unsubscribe error:", err);
      return new Response(JSON.stringify({ error: "Error interno" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
};
