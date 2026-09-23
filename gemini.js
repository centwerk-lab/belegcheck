// Bon-Erkennung mit Google Gemini (kostenloses Kontingent der Gemini-API).
// Der API-Schlüssel wird nur lokal auf dem iPhone gespeichert.
'use strict';

const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lesbar: { type: 'BOOLEAN', description: 'false, wenn das Bild kein Kassenbon oder unlesbar ist' },
    store: { type: 'STRING', description: 'Kurzname des Geschäfts, z. B. "REWE", "Lidl", "dm", "Aral"' },
    store_category: { type: 'STRING', enum: STORE_CATEGORIES },
    purchase_date: { type: 'STRING', description: 'YYYY-MM-DD' },
    purchase_time: { type: 'STRING', description: 'HH:MM oder leer' },
    total_cents: { type: 'INTEGER', description: 'Zu zahlender Gesamtbetrag in Cent' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          raw_name: { type: 'STRING', description: 'Artikeltext exakt wie auf dem Bon' },
          product_name: { type: 'STRING', description: 'Vereinheitlichter deutscher Produktname inkl. Größe' },
          category: { type: 'STRING', enum: ITEM_CATEGORIES },
          brand_type: { type: 'STRING', enum: ['marke', 'eigenmarke', 'unbekannt'] },
          quantity: { type: 'NUMBER' },
          unit: { type: 'STRING', enum: ['stk', 'kg', 'l'] },
          unit_price_cents: { type: 'INTEGER' },
          total_cents: { type: 'INTEGER', description: 'Zeilenbetrag in Cent nach Artikelrabatt; negativ bei Leergut/Rabatt' },
        },
        required: ['raw_name', 'product_name', 'category', 'quantity', 'unit', 'total_cents'],
      },
    },
    hinweis: { type: 'STRING', description: 'Kurzer Hinweis auf Unsicherheiten, sonst leer' },
  },
  required: ['lesbar', 'store', 'store_category', 'purchase_date', 'total_cents', 'items'],
};

function geminiPrompt(knownProducts, today) {
  return `Du erfasst deutsche Kassenbons für ein persönliches Haushaltsbuch. Heute ist ${today}.

Regeln:
- Erfasse JEDE Artikelzeile. Mehrere Fotos gehören zu EINEM langen Bon – Überschneidungen nicht doppelt zählen.
- Mengenzeilen wie "2 x 1,29" oder "0,456 kg x 2,99 EUR/kg" gehören zum Artikel: quantity/unit/unit_price_cents setzen.
- Artikelrabatte (z. B. "Rabatt", "Preisvorteil" direkt unter einem Artikel) mit dem Artikel verrechnen: total_cents = Betrag nach Rabatt.
- Bon-weite Rabatte/Coupons als eigene Zeile mit Kategorie "Rabatt" und negativem Betrag.
- Pfand: Kategorie "Pfand" (positiv); Leergut-Rückgabe: Kategorie "Pfand" mit negativem Betrag.
- product_name: Abkürzungen auflösen, Größe/Menge ergänzen wenn erkennbar, Schreibweise einheitlich.
  Nutze EXAKT einen der bekannten Produktnamen, wenn es dasselbe Produkt ist.
- brand_type: "eigenmarke" bei Handelsmarken (z. B. ja!, Gut & Günstig, Milbona, K-Classic, Balea, REWE Beste Wahl), "marke" bei Herstellermarken.
- Alle Beträge in CENT als ganze Zahl (2,99 € = 299). total_cents = tatsächlich zu zahlender Endbetrag.
- Wenn etwas unsicher ist, trotzdem bestmöglich ausfüllen und im Feld "hinweis" kurz nennen.

Bekannte Produktnamen (bevorzugt verwenden):
${knownProducts.length ? knownProducts.join('\n') : '(noch keine)'}`;
}

async function geminiExtract({ apiKey, model, images, knownProducts, today }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || GEMINI_DEFAULT_MODEL)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: geminiPrompt(knownProducts, today) }] },
    contents: [{
      role: 'user',
      parts: [
        ...images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
        { text: 'Erfasse diesen Kassenbon.' },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0 },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Keine Verbindung zu Gemini. Bitte Internetverbindung prüfen.');
  }

  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try { msg = JSON.parse(txt).error?.message || txt; } catch { /* Rohtext */ }
    if (res.status === 429) throw new Error('Kostenloses Gemini-Kontingent gerade ausgeschöpft. Bitte in ein paar Minuten (oder morgen) erneut versuchen – die Fotos bleiben erhalten.');
    if (res.status === 400 && /API key/i.test(msg)) throw new Error('Der Gemini-API-Schlüssel ist ungültig. Bitte unter „Mehr“ prüfen.');
    if (res.status === 403) throw new Error('Gemini verweigert den Zugriff (403). API-Schlüssel und dessen Einschränkungen prüfen.');
    if (res.status === 404) throw new Error(`Modell „${model}“ nicht gefunden. Unter „Mehr“ ein aktuelles Modell eintragen.`);
    throw new Error(`Gemini-Fehler ${res.status}: ${String(msg).slice(0, 200)}`);
  }

  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
  if (!text) throw new Error(`Gemini hat keine Daten geliefert${cand?.finishReason ? ` (${cand.finishReason})` : ''}. Bitte erneut versuchen.`);
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Die Antwort von Gemini war unvollständig. Bitte erneut versuchen.');
  }
}
