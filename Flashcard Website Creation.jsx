import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Anki‑lite: Chemistry flashcards with cloze + SRS (10‑day cram)
 *
 * Card formats:
 *  - Basic:  Front | Back
 *  - Cloze:  {{c1::hidden text}} rest of sentence
 *
 * Shortcuts: Space = reveal · ←/→ = prev/next · 1/2/3/4 = Again/Hard/Good/Easy · S = shuffle · R = reset · F = fullscreen
 */

const DEFAULT_DECK = `Acid + Base | Salt + Water
Strong acid (e.g. HCl) | Fully dissociates into H+ in solution
Weak acid (e.g. CH3COOH) | {{c1::Partially dissociates}} in solution
pH of neutral solution | {{c1::7 at 25°C}}
Le Chatelier’s principle | If a system is {{c1::disturbed}}, it will shift to oppose the change
Oxidation | {{c1::Loss of electrons}} (OIL RIG)
Reduction | {{c1::Gain of electrons}} (OIL RIG)
Titration | Find concentration using a {{c1::standard solution}}
Equilibrium constant (Kc) | Depends only on {{c1::temperature}}`;

// ---------- Helpers ----------
function now() { return Date.now(); }
function minutes(n){ return n * 60 * 1000; }
function hours(n){ return minutes(60*n); }
function days(n){ return hours(24*n); }

function parseDeck(text) {
  return text
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean)
    .map((ln, i) => {
      if (ln.includes("{{c")) {
        return baseSrs({ id: i + 1, type: "cloze", text: ln });
      }
      const m = ln.match(/^(.*?)(?:\s*(?:\|+|::|\t|—| - )\s*)(.*)$/);
      if (!m) return baseSrs({ id: i + 1, type: "basic", front: ln, back: "(no back)" });
      const [, front, back] = m;
      return baseSrs({ id: i + 1, type: "basic", front: front.trim(), back: back.trim() });
    });
}

function baseSrs(card){
  return {
    ...card,
    srs: { ease: 2.3, interval: 0, reps: 0, lapses: 0, due: now() } // due now by default
  };
}

function renderCloze(text, revealed) {
  return text.replace(/\{\{c\d+::(.*?)\}\}/g, (_, inner) => (revealed ? inner : "____"));
}

// Next‑interval logic tuned for a 10‑day cram window
function schedule(card, grade){
  const s = { ...card.srs };
  const cap = days(10); // cap any single jump to 10 days
  const first = s.reps === 0;
  const nowTs = now();
  let added = minutes(10);

  if (grade === "again") {
    s.lapses += 1; s.interval = 0; s.ease = Math.max(1.3, s.ease - 0.2);
    added = minutes(5); // quick retry
  } else if (grade === "hard") {
    s.reps += 1; s.ease = Math.max(1.3, s.ease - 0.05);
    added = first ? minutes(20) : Math.min(cap, (s.interval || hours(8)) * 0.6);
  } else if (grade === "good") {
    s.reps += 1; // keep ease stable for cram
    added = first ? hours(8) : Math.min(cap, (s.interval || hours(8)) * Math.max(1.7, s.ease));
  } else if (grade === "easy") {
    s.reps += 1; s.ease = Math.min(2.7, (s.ease || 2.3) + 0.05);
    added = first ? days(1) : Math.min(cap, (s.interval || hours(8)) * ((s.ease || 2.3) + 0.15));
  }
  s.interval = added;
  s.due = nowTs + added;
  return { ...card, srs: s };
}

// ---------- Tiny test runner ----------
function expect(cond, msg){ if(!cond) throw new Error(msg); }
function runSelfTests(){
  const sample = [
    "Front | Back",
    "{{c1::Hidden}} shown",
    "Left :: Right",
    "Foo\tBar",
    "Alpha — Beta",
    "Gamma - Delta"
  ].join("\n");
  const d = parseDeck(sample);
  expect(d.length === 6, "parse length");
  expect(d[0].type === "basic" && d[0].front === "Front" && d[0].back === "Back", "basic parse");
  expect(d[1].type === "cloze", "cloze type");
  expect(renderCloze(d[1].text, false).includes("____"), "cloze hide");
  const scheduled = schedule(baseSrs({ id: 99, type: "basic", front: "A", back: "B" }), "good");
  expect(scheduled.srs.due > now(), "schedule in future");
}

export default function AnkiLiteApp() {
  const [input, setInput] = useState(() => localStorage.getItem("anki_input") || DEFAULT_DECK);
  const [deck, setDeck] = useState(() => {
    const saved = localStorage.getItem("anki_deck_v2");
    return saved ? JSON.parse(saved) : parseDeck(DEFAULT_DECK);
  });
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [mode, setMode] = useState("review"); // review | browse
  const [shuffled, setShuffled] = useState(false);
  const rootRef = useRef(null);

  const total = deck.length;

  // Compute due queue
  const dueCards = useMemo(() => deck
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (mode === "review" ? (c.srs && c.srs.due <= now()) : true))
    .sort((a, b) => ((a.c.srs?.due || 0) - (b.c.srs?.due || 0))), [deck, mode]);

  const currentIdx = mode === "review" ? (dueCards[0]?.i ?? 0) : index;
  const current = deck[currentIdx] || {};

  useEffect(() => { localStorage.setItem("anki_input", input); }, [input]);
  useEffect(() => { localStorage.setItem("anki_deck_v2", JSON.stringify(deck)); }, [deck]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") { e.preventDefault(); flip(); }
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key.toLowerCase() === "s") shuffleDeck();
      else if (e.key.toLowerCase() === "r") resetProgress();
      else if (e.key === "1") grade("again");
      else if (e.key === "2") grade("hard");
      else if (e.key === "3") grade("good");
      else if (e.key === "4") grade("easy");
      else if (e.key.toLowerCase() === "f") toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, index, revealed, mode]);

  function loadDeck() {
    try { runSelfTests(); } catch(e){ console.warn("Self‑tests failed:", e); }
    const parsed = parseDeck(input);
    setDeck(parsed);
    setIndex(0);
    setRevealed(false);
    setShuffled(false);
  }

  function next() {
    if (mode === "review") { setRevealed(false); return; } // in review, next is managed by grading
    setRevealed(false);
    setIndex((i) => (i + 1 < total ? i + 1 : 0));
  }
  function prev() {
    setRevealed(false);
    setIndex((i) => (i - 1 >= 0 ? i - 1 : Math.max(0, total - 1)));
  }
  function flip() { setRevealed((b) => !b); }

  function shuffleDeck() {
    const arr = [...deck];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    setDeck(arr);
    setIndex(0);
    setRevealed(false);
    setShuffled(true);
  }
  function resetProgress() {
    setDeck((d) => d.map((c) => ({ ...c, srs: { ...c.srs, reps: 0, lapses: 0, interval: 0, ease: 2.3, due: now() } })));
    setIndex(0);
    setRevealed(false);
  }

  function grade(level){
    if (!revealed) { setRevealed(true); return; } // require reveal before grading
    const i = currentIdx;
    setDeck((d) => d.map((c, k) => (k === i ? schedule(c, level) : c)));
    setRevealed(false);
  }

  function toggleFullscreen(){
    const el = rootRef.current || document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }

  const dueCount = dueCards.length;
  const progress = total ? Math.round(((total - dueCount) / total) * 100) : 0;

  return (
    <div ref={rootRef} className="min-h-screen w-full bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 flex flex-col items-center p-6">
      <div className="w-full max-w-5xl grid gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Anki‑lite Chemistry (10‑day cram)</h1>
          <div className="flex items-center gap-2">
            <button onClick={toggleFullscreen} className="px-3 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800 text-sm">⛶ Fullscreen (F)</button>
            <DarkModeToggle />
          </div>
        </header>

        <section className="grid lg:grid-cols-2 gap-4">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow p-4">
            <label className="block text-sm mb-2 font-medium">Enter your cards (Basic or {'{{c1::cloze}}'}):</label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="w-full h-48 p-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={"Oxidation | Loss of electrons\nBuffer | Resists pH change\nStrong acid | {{c1::Fully dissociates}}"}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={loadDeck} className="px-4 py-2 rounded-xl bg-indigo-600 text-white shadow hover:brightness-110">Load deck</button>
              <button onClick={() => setMode(mode === "review" ? "browse" : "review")} className="px-4 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800">Mode: {mode === "review" ? "Review (due)" : "Browse (all)"}</button>
              <button onClick={shuffleDeck} className="px-4 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800">Shuffle (S)</button>
              <button onClick={resetProgress} className="px-4 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800">Reset (R)</button>
              <button onClick={() => { try { runSelfTests(); alert("Self‑tests passed ✔"); } catch(e){ alert("Self‑tests failed: " + e.message); } }} className="px-4 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800">Run tests</button>
              <span className="ml-auto text-sm opacity-70 self-center">{total} cards · due {dueCount}</span>
            </div>
          </div>

          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow p-4 flex flex-col">
            <div className="text-sm mb-2">{mode === "review" ? `Due: ${dueCount}` : `Card ${index + 1}/${total}`} · {progress}%</div>
            <div className="w-full h-2 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden mb-3">
              <div className="h-full bg-indigo-600" style={{ width: `${progress}%` }} />
            </div>

            <button
              onClick={flip}
              className="relative flex-1 min-h-[300px] rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 shadow-inner outline-none focus:ring-2 focus:ring-indigo-500 p-6 text-xl font-medium text-center whitespace-pre-wrap"
            >
              {current.type === "basic"
                ? (revealed ? current.back : current.front)
                : renderCloze(current.text, revealed)}
            </button>

            {mode === "review" ? (
              <div className="mt-3 grid grid-cols-4 gap-2 text-sm">
                <button onClick={() => grade("again")} className="px-3 py-2 rounded-xl bg-rose-200 dark:bg-rose-900/40">1 Again</button>
                <button onClick={() => grade("hard")} className="px-3 py-2 rounded-xl bg-amber-200 dark:bg-amber-900/40">2 Hard</button>
                <button onClick={() => grade("good")} className="px-3 py-2 rounded-xl bg-emerald-200 dark:bg-emerald-900/40">3 Good</button>
                <button onClick={() => grade("easy")} className="px-3 py-2 rounded-xl bg-sky-200 dark:bg-sky-900/40">4 Easy</button>
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2">
                <button onClick={prev} className="px-4 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800">← Prev</button>
                <button onClick={flip} className="px-4 py-2 rounded-xl bg-indigo-600 text-white">{revealed ? "Hide" : "Reveal"} (Space)</button>
                <button onClick={next} className="px-4 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800">Next →</button>
              </div>
            )}
            <p className="text-xs opacity-70 mt-2">Shortcuts: Space · ←/→ · 1/2/3/4 · S · R · F</p>
          </div>
        </section>

        <footer className="text-xs opacity-70 text-center mt-2">SRS tuned for ~10‑day exams: Again=5m, Hard≈20m, Good≈8h⇢, Easy≈1d⇢ (capped at 10d).</footer>
      </div>
    </div>
  );
}

function DarkModeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("anki_dark");
    const prefers = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored ? stored === "1" : prefers;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);
  return (
    <button
      onClick={() => {
        const next = !dark;
        setDark(next);
        localStorage.setItem("anki_dark", next ? "1" : "0");
        document.documentElement.classList.toggle("dark", next);
      }}
      className="px-3 py-2 rounded-xl bg-neutral-200 dark:bg-neutral-800 text-sm"
    >
      {dark ? "☾ Dark" : "☼ Light"}
    </button>
  );
}
