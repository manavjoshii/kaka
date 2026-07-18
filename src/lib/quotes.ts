// Name-infused header quotes — a short, natural-sounding sentence that
// greets you and nudges you to do something today. Keep these SHORT (the
// original bumper-sticker style had the right length — just write them as
// real sentences instead of fragments).
// Use {name} as the placeholder.
export const HEADER_QUOTES: string[] = [
  "Let's build something today, {name}.",
  "{name}, today's worth showing up for.",
  "Go make today count, {name}.",
  "{name}, your future self is watching.",
  "Today's a good day to start, {name}.",
  "{name}, do one brave thing today.",
  "Show up for yourself today, {name}.",
  "{name}, the work is waiting for you.",
  "One real thing today, {name} — that's all.",
  "{name}, you've got this today.",
  "Today's yours to make count, {name}.",
  "{name}, keep showing up.",
  "Let's make today matter, {name}.",
  "{name}, small steps still move you forward.",
  "Today's a fresh page, {name}.",
  "{name}, go chase something real today.",
  "Make today honest, {name}.",
  "{name}, momentum starts with one step.",
];

export function renderHeaderQuote(name: string, seed = new Date().getHours()): string {
  const safe = name.trim() || "friend";
  const idx = Math.abs(seed) % HEADER_QUOTES.length;
  return HEADER_QUOTES[idx]!.replace(/\{name\}/g, safe);
}

// Timeless tweets / quotes. Keep them short, attributed, real.
export const FOOTER_QUOTES: { text: string; by: string }[] = [
  { text: "Seek wealth, not money or status.", by: "Naval" },
  { text: "Play long-term games with long-term people.", by: "Naval" },
  { text: "Read what you love until you love to read.", by: "Naval" },
  { text: "Stay hungry. Stay foolish.", by: "Steve Jobs" },
  { text: "The people who are crazy enough to think they can change the world are the ones who do.", by: "Steve Jobs" },
  { text: "When something is important enough, you do it even if the odds are not in your favor.", by: "Elon Musk" },
  { text: "The first step is to establish that something is possible; then probability will occur.", by: "Elon Musk" },
  { text: "Make something people want.", by: "Paul Graham" },
  { text: "Live in the future, then build what's missing.", by: "Paul Graham" },
  { text: "The best way to predict the future is to invent it.", by: "Alan Kay" },
  { text: "Compete and you become a copy. Create and you become an original.", by: "Peter Thiel" },
  { text: "Compare yourself to who you were yesterday, not to who someone else is today.", by: "Jordan Peterson" },
  { text: "I never lose. I either win or I learn.", by: "Nelson Mandela" },
  { text: "Self-belief and hard work will always earn you success.", by: "Virat Kohli" },
  { text: "Why fear? When you are confident, you are not afraid.", by: "MS Dhoni" },
  { text: "I'm a big believer in 'you make your own luck.'", by: "Rafael Nadal" },
  { text: "You have to believe in the long term plan, but you need the short term goals to motivate.", by: "Roger Federer" },
  { text: "Either you run the day or the day runs you.", by: "Jim Rohn" },
];

export function pickFooterQuote(seed = Math.floor(Date.now() / 60000)): { text: string; by: string } {
  return FOOTER_QUOTES[Math.abs(seed) % FOOTER_QUOTES.length]!;
}

// Time-aware composer suggestions. Returned set is shuffled with recency bias.
const MORNING = [
  "Plan my top 3 for today",
  "Meditate 10 minutes daily",
  "Workout 30 minutes",
  "Drink 2L of water daily",
  "Journal for 5 minutes",
];
const MIDDAY = [
  "Deep work block for 90 minutes",
  "Reply to important emails today 3pm",
  "Lunch walk for 15 minutes",
  "Review weekly goals Friday 5pm",
];
const EVENING = [
  "Call mom tonight 8pm",
  "Read 20 minutes every day",
  "Walk after dinner",
  "Cook something new tomorrow",
];
const NIGHT = [
  "Plan tomorrow morning",
  "Stretch 5 minutes before bed",
  "No screens after 11pm daily",
  "Reflect on today in journal",
];
const WEEKEND = [
  "Grocery run Saturday 11am",
  "Call dad on Sunday",
  "Long walk Sunday morning",
  "Plan the week Sunday 9pm",
];

export function smartSuggestions(now = new Date(), recent: string[] = []): string[] {
  const h = now.getHours();
  const day = now.getDay(); // 0 Sun, 6 Sat
  const isWeekend = day === 0 || day === 6;
  let base: string[];
  if (h < 11) base = MORNING;
  else if (h < 15) base = MIDDAY;
  else if (h < 20) base = EVENING;
  else base = NIGHT;
  const pool = [...base, ...(isWeekend ? WEEKEND : [])];
  // Add a "repeat" suggestion from recent past inputs.
  const recentClean = recent
    .map((r) => r.trim())
    .filter((r) => r.length > 3 && r.length < 80)
    .slice(0, 3);
  return [...recentClean, ...pool];
}