// api/chat.js
// Runs on the SERVER (Vercel). The API keys never reach the browser.

// If one model is busy or fails, the server automatically tries the next one.
const MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview"];

// Patients can book today, tomorrow and the day after (3 days in total).
const DAYS_AHEAD = 3;

// ---- DOCTORS AND THEIR DAILY SLOTS (edit here to change them) ----
const DOCTORS = [
  { name: "Dr. Meera Kapoor", dept: "General Medicine", slots: ["10:00 AM", "10:45 AM", "11:30 AM", "3:00 PM"] },
  { name: "Dr. Arjun Rao", dept: "Orthopedics", slots: ["11:00 AM", "11:45 AM", "2:00 PM", "2:45 PM"] },
  { name: "Dr. Sana Iqbal", dept: "Dermatology", slots: ["10:30 AM", "12:15 PM", "3:30 PM", "4:15 PM"] },
];

// ---- STEP A: the system prompt (the "brain" of the chatbot) ----
const SYSTEM_PROMPT = `
You are MediBook, a virtual assistant for Sunrise Clinic in India.

Your job: help patients book, reschedule, or cancel doctor appointments.

To book, collect these one at a time:
1. Patient name
2. Reason for visit
3. Whether they have visited us before, and if so, which doctor they usually consult
4. Day (today, tomorrow, or the day after tomorrow)
5. Appointment slot

Rules:
- Ask only one question at a time.
- The patient name must contain only letters and spaces (capital letters allowed). If it has numbers or symbols, politely say it isn't valid and ask again. Never accept it.
- Don't ask for a "preferred doctor." Ask: "Have you visited us before? If so, is there a particular doctor you usually consult?" If they're new, assign the first doctor in the list below who still has a free slot on the chosen day.
- Time slots: never accept free-text times like "in 2 hours." Show only the free slots for the chosen day and ask the patient to pick one. If they ask for another time, politely explain that only the listed slots can be booked.
- Slots are 30 minutes long, with a 15-minute buffer between them.
- Never give medical advice or diagnoses. Say: "I can't give medical advice, but a doctor can help at your appointment."
- If the user describes an emergency (chest pain, heavy bleeding, trouble breathing), tell them to call an ambulance (108) or 112 immediately.
- If asked anything unrelated to appointments, politely say you can only help with bookings.
- Keep replies under 3 sentences. Tone: warm and professional. A list of slots does not count toward this limit.
`;

// Rules used when the live booking database is working.
const LIVE_RULES = `
Booking, cancelling and rescheduling:
- Patients can book only for the three days listed above. If they ask for another day, say only these days can be booked.
- Offer only free slots from the live list, for the patient's doctor and chosen day. Never invent a doctor, day or time. If that doctor has no free slot on that day, offer another day or another doctor.
- To book: when you have the name, reason, doctor, day and slot, call book_slot (date as YYYY-MM-DD from the date codes above, time exactly as listed). Do not say it is booked until the tool returns status "booked".
- To cancel: ask for the patient's name, call find_bookings, and make sure which booking they mean. Ask "Do you want me to cancel it?" and only after a clear yes, call cancel_booking.
- To reschedule: ask for the patient's name, call find_bookings, confirm which booking, ask for the new day and slot from the free list, then call reschedule_booking.
- If a tool returns "slot_taken", apologize briefly and offer the updated free slots from the tool result. If it returns "not_found", say you could not find a booking under that name. If it returns "error", ask the patient to contact the clinic.
- After a success, confirm in the matching format and say the clinic will send the final confirmation:
  Booked: Name: ... | Reason: ... | Doctor: ... | Date/Time: ...
  Cancelled: Name: ... | Doctor: ... | Date/Time: ...
  Rescheduled: Name: ... | Doctor: ... | From: ... | To: ...
`;

// Rules used if the booking database is temporarily unavailable.
const OFFLINE_RULES = `
Booking rules:
- The live booking system is temporarily unavailable. Offer only slots from the list above and never invent any.
- Do not say a slot is guaranteed. Confirm the details in this format and say the clinic will send the final confirmation:
  Name: ... | Reason: ... | Doctor: ... | Date/Time: ...
- For rescheduling or cancelling, say the clinic staff will handle it.
`;

// ---- STEP B: rules for using the patient's past records ----
const RECORDS_RULES = `
You may also be given the patient's previous appointment records below.
- If the patient asks about past visits, answer only from these records, in simple words.
- Never add diagnoses, advice, or opinions of your own.
- Never rate or compare doctors or treatments.
- If the answer is not in the records, say you don't have that information.
`;

// ---- The tools the AI can use ----
const S = (d) => ({ type: "string", description: d });
const TOOL_DECLARATIONS = [
  { name: "book_slot", description: "Books one slot for a patient. Call only after the patient chose a free slot and you have their name and reason.",
    parameters: { type: "object", required: ["doctor", "date", "time", "patient_name", "reason"], properties: {
      doctor: S("Doctor name, e.g. Dr. Meera Kapoor"), date: S("Date as YYYY-MM-DD from the date codes"), time: S("Slot time exactly as listed, e.g. 10:00 AM"),
      patient_name: S("Patient name, letters and spaces only"), reason: S("Reason for the visit") } } },
  { name: "find_bookings", description: "Finds the upcoming bookings of a patient by name. Use before cancelling or rescheduling.",
    parameters: { type: "object", required: ["patient_name"], properties: { patient_name: S("Patient name, letters and spaces only") } } },
  { name: "cancel_booking", description: "Cancels one booking. Call only after the patient clearly agreed to cancel.",
    parameters: { type: "object", required: ["patient_name", "doctor", "date", "time"], properties: {
      patient_name: S("Patient name"), doctor: S("Doctor name"), date: S("Date as YYYY-MM-DD"), time: S("Slot time, e.g. 10:00 AM") } } },
  { name: "reschedule_booking", description: "Moves a booking to a new free slot. The old slot is released only if the new one is booked.",
    parameters: { type: "object", required: ["patient_name", "old_doctor", "old_date", "old_time", "new_doctor", "new_date", "new_time"], properties: {
      patient_name: S("Patient name"), old_doctor: S("Current doctor"), old_date: S("Current date as YYYY-MM-DD"), old_time: S("Current slot time"),
      new_doctor: S("New doctor"), new_date: S("New date as YYYY-MM-DD"), new_time: S("New slot time") } } },
];

// ---- Shared database (Upstash Redis, over HTTPS) ----
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(5000),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// ---- Dates and times (India time) ----
function istNow() {
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // 2026-11-22
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const [h, m] = hm.split(":").map(Number);
  return { today, minutes: (h % 24) * 60 + m };
}
function bookableDates() {
  const { today } = istNow();
  const names = ["Today", "Tomorrow", "Day after tomorrow"];
  const out = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const label = d.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
    out.push({ iso: d.toISOString().slice(0, 10), label: (names[i] || "Later") + " (" + label + ")" });
  }
  return out;
}
function slotMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t);
  return ((+m[1] % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + +m[2];
}
const dayKey = (iso) => "slots:" + iso;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normTime = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");
const cleanName = (s) => { const n = String(s || "").trim(); return /^[A-Za-z ]{2,60}$/.test(n) ? n : null; };
const parseHash = (raw) => {
  if (Array.isArray(raw)) { const o = {}; for (let i = 0; i + 1 < raw.length; i += 2) o[raw[i]] = raw[i + 1]; return o; }
  return raw || {};
};
const ownerOf = (v) => { try { return JSON.parse(v).name.toLowerCase(); } catch (e) { return null; } };

// Checks a doctor, date and time. Returns { doc, slot, date } or { err }.
function checkSlot(dateIso, doctor, time, allowPast) {
  const dates = bookableDates();
  const date = dates.find((d) => d.iso === String(dateIso || "").trim());
  if (!date) return { err: { status: "invalid_date", message: "Only today, tomorrow and the day after can be used." } };
  const q = norm(doctor);
  const doc = q && DOCTORS.find((d) => norm(d.name).includes(q) || q.includes(norm(d.name)));
  if (!doc) return { err: { status: "invalid_doctor", message: "No such doctor. Use a doctor from the list." } };
  const slot = doc.slots.find((t) => normTime(t) === normTime(time));
  if (!slot) return { err: { status: "invalid_slot", message: "That time is not one of this doctor's slots." } };
  const { today, minutes } = istNow();
  if (!allowPast && date.iso === today && slotMinutes(slot) <= minutes) return { err: { status: "invalid_slot", message: "That time has already passed today." } };
  return { doc, slot, date };
}

// TOOL / FUNCTION 1: which slots are still free right now? (used on every message)
async function getFreeSlots() {
  const dates = bookableDates();
  const { today, minutes } = istNow();
  const hashes = await Promise.all(dates.map((d) => redis(["HGETALL", dayKey(d.iso)])));
  return dates.map((d, i) => {
    const taken = parseHash(hashes[i]);
    const doctors = {};
    DOCTORS.forEach((doc) => {
      doctors[doc.name] = doc.slots.filter((t) => !(doc.name + "|" + t in taken) && !(d.iso === today && slotMinutes(t) <= minutes));
    });
    return { iso: d.iso, label: d.label, doctors };
  });
}

// TOOL / FUNCTION 2: book one slot. HSETNX only succeeds if the slot is still empty,
// so two people can never get the same slot, even at the same moment.
async function bookSlot(a) {
  const name = cleanName(a.patient_name);
  if (!name) return { status: "invalid_name", message: "Name must contain only letters and spaces." };
  const v = checkSlot(a.date, a.doctor, a.time, false);
  if (v.err) return v.err;
  const key = dayKey(v.date.iso), field = v.doc.name + "|" + v.slot;
  const ok = { status: "booked", doctor: v.doc.name, date: v.date.label, time: v.slot };
  const set = await redis(["HSETNX", key, field, JSON.stringify({ name, reason: String(a.reason || "").slice(0, 200) })]);
  if (set === 1) { await redis(["EXPIRE", key, 432000]).catch(() => {}); return ok; }
  if (ownerOf(await redis(["HGET", key, field])) === name.toLowerCase()) return ok; // same patient retrying
  return { status: "slot_taken", message: "Someone just booked this slot.", free_slots_now: await getFreeSlots() };
}

// Lists the upcoming bookings of one patient.
async function findBookings(a) {
  const name = cleanName(a.patient_name);
  if (!name) return { status: "invalid_name", message: "Name must contain only letters and spaces." };
  const dates = bookableDates();
  const hashes = await Promise.all(dates.map((d) => redis(["HGETALL", dayKey(d.iso)])));
  const found = [];
  dates.forEach((d, i) => {
    const h = parseHash(hashes[i]);
    Object.keys(h).forEach((field) => {
      if (ownerOf(h[field]) === name.toLowerCase()) { const [doctor, time] = field.split("|"); found.push({ doctor, date: d.iso, date_label: d.label, time, m: slotMinutes(time) }); }
    });
  });
  found.sort((x, y) => (x.date + String(x.m).padStart(4, "0")).localeCompare(y.date + String(y.m).padStart(4, "0")));
  return found.length ? { status: "ok", bookings: found.map(({ m, ...rest }) => rest) } : { status: "none", message: "No upcoming bookings under this name." };
}

// Cancels a booking, only if it belongs to the patient name given.
async function cancelBooking(a) {
  const name = cleanName(a.patient_name);
  if (!name) return { status: "invalid_name", message: "Name must contain only letters and spaces." };
  const v = checkSlot(a.date, a.doctor, a.time, true);
  if (v.err) return v.err;
  const key = dayKey(v.date.iso), field = v.doc.name + "|" + v.slot;
  if (ownerOf(await redis(["HGET", key, field])) !== name.toLowerCase()) return { status: "not_found", message: "No booking found for this name and slot." };
  await redis(["HDEL", key, field]);
  return { status: "cancelled", doctor: v.doc.name, date: v.date.label, time: v.slot };
}

// Moves a booking. The new slot is booked first; the old one is released only if that worked.
async function rescheduleBooking(a) {
  const name = cleanName(a.patient_name);
  if (!name) return { status: "invalid_name", message: "Name must contain only letters and spaces." };
  const o = checkSlot(a.old_date, a.old_doctor, a.old_time, true);
  if (o.err) return o.err;
  const n = checkSlot(a.new_date, a.new_doctor, a.new_time, false);
  if (n.err) return n.err;
  const oKey = dayKey(o.date.iso), oField = o.doc.name + "|" + o.slot;
  const nKey = dayKey(n.date.iso), nField = n.doc.name + "|" + n.slot;
  if (oKey === nKey && oField === nField) return { status: "same_slot", message: "The new slot is the same as the current one." };
  const oldRaw = await redis(["HGET", oKey, oField]);
  if (ownerOf(oldRaw) !== name.toLowerCase()) return { status: "not_found", message: "No booking found for this name and slot." };
  let reason = ""; try { reason = JSON.parse(oldRaw).reason || ""; } catch (e) {}
  const done = { status: "rescheduled", doctor: n.doc.name, from: o.date.label + " " + o.slot + " with " + o.doc.name, to: n.date.label + " " + n.slot + " with " + n.doc.name };
  const set = await redis(["HSETNX", nKey, nField, JSON.stringify({ name, reason })]);
  if (set === 1) { await redis(["EXPIRE", nKey, 432000]).catch(() => {}); await redis(["HDEL", oKey, oField]); return done; }
  if (ownerOf(await redis(["HGET", nKey, nField])) === name.toLowerCase()) { await redis(["HDEL", oKey, oField]); return done; } // retry
  return { status: "slot_taken", message: "The new slot was just taken. The old booking is unchanged.", free_slots_now: await getFreeSlots() };
}

const TOOLS = { book_slot: bookSlot, find_bookings: findBookings, cancel_booking: cancelBooking, reschedule_booking: rescheduleBooking };

// ---- Talk to one Gemini model, running the tools if it asks ----
async function askModel(model, apiKey, systemText, contents, useTools) {
  const convo = contents.slice();
  for (let step = 0; step < 5; step++) {
    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: convo,
      generationConfig: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
    };
    if (useTools) body.tools = [{ functionDeclarations: TOOL_DECLARATIONS }];

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    const content = data?.candidates?.[0]?.content;
    if (!content) { console.error(model + " gave no content:", JSON.stringify(data).slice(0, 300)); return null; }

    const calls = (content.parts || []).filter((p) => p.functionCall);
    if (calls.length === 0) {
      const text = (content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      return text || null;
    }
    convo.push(content); // keep the model's tool request exactly as received
    const results = [];
    for (const c of calls) {
      const fn = TOOLS[c.functionCall.name];
      let out;
      try { out = fn ? await fn(c.functionCall.args || {}) : { status: "error", message: "Unknown tool" }; }
      catch (err) { console.error(c.functionCall.name + " error:", err.message); out = { status: "error", message: "Booking system unavailable. Ask the patient to contact the clinic." }; }
      results.push({ functionResponse: { name: c.functionCall.name, response: out } });
    }
    convo.push({ role: "user", parts: results });
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key is not set" });

  const { messages, records } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "No messages" });

  const contents = messages.slice(-20).map((m) => ({
    role: m.role === "model" ? "model" : "user",
    parts: [{ text: String(m.text || "").slice(0, 2000) }],
  }));
  while (contents.length && contents[0].role === "model") contents.shift();

  // Ask the database which slots are free right now. If it is down, fall back to the full list.
  let live = Boolean(REDIS_URL && REDIS_TOKEN);
  let days = null;
  if (live) {
    try { days = await getFreeSlots(); } catch (err) { console.error("redis error:", err.message); live = false; }
  }
  if (!live) {
    const { today, minutes } = istNow();
    days = bookableDates().map((d) => ({ iso: d.iso, label: d.label, doctors: Object.fromEntries(DOCTORS.map((doc) => [doc.name, doc.slots.filter((t) => !(d.iso === today && slotMinutes(t) <= minutes))])) }));
  }

  const slotBlock = "\n" + (live ? "FREE SLOTS RIGHT NOW (live list; booked and past slots are already removed). Date codes are in brackets." : "SLOTS (not live).") + "\n" +
    days.map((d) => `== ${d.label} [${d.iso}] ==\n` + DOCTORS.map((doc) => `${doc.name} (${doc.dept}): ${d.doctors[doc.name].length ? d.doctors[doc.name].join(", ") : "no free slots"}`).join("\n")).join("\n") + "\n";
  const safeRecords = Array.isArray(records) ? records.slice(0, 20) : [];
  const systemText = SYSTEM_PROMPT + slotBlock + (live ? LIVE_RULES : OFFLINE_RULES) + "\n" + RECORDS_RULES + "\nPATIENT RECORDS:\n" + JSON.stringify(safeRecords);

  for (const model of MODELS) {
    try {
      const reply = await askModel(model, apiKey, systemText, contents, live);
      if (reply) return res.status(200).json({ reply });
    } catch (err) {
      console.error(model + " error:", err.message);
    }
  }
  return res.status(502).json({ error: "All models are busy" });
};
