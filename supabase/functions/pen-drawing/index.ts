// Supabase Edge Function "pen-drawing".
// Takes a finished Words game, asks Claude for a pen line drawing of the sentence,
// checks the lines and saves them in ai_drawings. One drawing per game, ever.
// Secret needed in Supabase: ANTHROPIC_API_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are built in.
import Anthropic from "npm:@anthropic-ai/sdk";

const DAILY_LIMIT = Number(Deno.env.get("PEN_DAILY_LIMIT") ?? "60"); // cost guard for the whole site
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const DB_URL = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "") + "/rest/v1/";
const DB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(DB_URL + path, {
    ...init,
    headers: {
      apikey: DB_KEY,
      ...(DB_KEY.startsWith("sb_") ? {} : { Authorization: "Bearer " + DB_KEY }),
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error("database " + r.status + " " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const SYSTEM = `You are a surrealist pen artist playing cadavre exquis (exquisite corpse), the 1920s drawing game.
You get one absurd sentence that the players wrote without seeing each other's part. Draw it.

How the drawing should look:
- One fine black ink pen drawing, like the surrealists' exquisite corpse drawings: a single strange hybrid figure or a tiny scene that takes the sentence literally.
- Build it top to bottom like a folded exquisite corpse: head at the top, body in the middle, legs or base at the bottom, so the parts feel made by different hands but still join.
- Confident, minimal contour lines. A few small details are welcome (an eye, a texture, a little hatching), but no heavy shading, no text, no letters, no frame, no ground line across the whole page.
- Use the whole canvas with a calm margin.

Format:
- The canvas is 1000 by 1000, x to the right, y down.
- Each stroke is one pen line without lifting, written as "x,y,x,y,..." with whole numbers.
- Place points every 10 to 30 units along a curve; the renderer smooths through them.
- Use 15 to 60 strokes and at most 3000 points in total.`;

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short poetic title for the drawing, in the sentence's language." },
    strokes: { type: "array", items: { type: "string" } },
  },
  required: ["title", "strokes"],
  additionalProperties: false,
};

// keep only clean number pairs inside the canvas
function clean(strokes: unknown): string[] {
  if (!Array.isArray(strokes)) return [];
  const out: string[] = [];
  let total = 0;
  for (const s of strokes.slice(0, 80)) {
    if (typeof s !== "string") continue;
    const n = s.split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.length < 2 || n.some((v) => !Number.isFinite(v))) continue;
    const pts = n.slice(0, n.length - (n.length % 2)).slice(0, 800).map((v) => Math.max(0, Math.min(1000, Math.round(v))));
    total += pts.length / 2;
    if (total > 4000) break;
    out.push(pts.join(","));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const { game_id } = await req.json();
    if (typeof game_id !== "string" || !/^[a-z0-9]{8}$/.test(game_id)) return json({ error: "Unknown game" }, 400);

    // already drawn: give the same drawing back
    const have = await db(`ai_drawings?game_id=eq.${game_id}&select=strokes,title`);
    if (have?.length) return json(have[0]);

    const g = (await db(`games?id=eq.${game_id}&select=edition,parts,turns(n,text)`))?.[0];
    if (!g || g.edition !== "words") return json({ error: "Only finished Words games can be drawn" }, 400);
    const turns = [...g.turns].sort((a: { n: number }, b: { n: number }) => a.n - b.n);
    if (turns.length < g.parts) return json({ error: "This sentence is not finished yet" }, 400);
    const sentence = turns.map((t: { text: string }) => t.text).join(" ").replace(/\s+/g, " ").trim();

    const since = new Date(Date.now() - 864e5).toISOString();
    const today = await db(`ai_drawings?created_at=gte.${since}&select=game_id`);
    if ((today?.length ?? 0) >= DAILY_LIMIT) return json({ error: "The AI has made enough drawings for today. Try again tomorrow." }, 429);

    const client = new Anthropic(); // reads ANTHROPIC_API_KEY
    const msg = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `The sentence: "${sentence}"` }],
    // deno-lint-ignore no-explicit-any
    } as any);

    if (msg.stop_reason === "refusal") return json({ error: "The AI would not draw this sentence." }, 422);
    // deno-lint-ignore no-explicit-any
    const text = (msg.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
    const out = JSON.parse(text);
    const strokes = clean(out.strokes);
    if (strokes.length < 3) return json({ error: "The drawing came out empty. Try again." }, 502);
    const row = { game_id, strokes: strokes.join("|"), title: String(out.title ?? "").slice(0, 80) };

    try {
      await db("ai_drawings", { method: "POST", body: JSON.stringify(row) });
    } catch (e) {
      // someone else drew it at the same moment: return theirs
      const again = await db(`ai_drawings?game_id=eq.${game_id}&select=strokes,title`);
      if (again?.length) return json(again[0]);
      throw e;
    }
    return json({ strokes: row.strokes, title: row.title });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
