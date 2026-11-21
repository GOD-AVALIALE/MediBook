// api/chat.js
// This runs on the SERVER (Vercel), not in the browser.
// That is why the API key stays safe: visitors never see this file or the key.

const MODEL = "gemini-3.5-flash"; // if this name stops working, check Google AI Studio for the current one

// STEP A: Paste your Version 2 system prompt between the backticks, replacing the example below.
const SYSTEM_PROMPT = `
You are MediBook, a virtual assistant for Sunrise Clinic in India.

Your job: help patients book, reschedule, or cancel doctor appointments.

To book, collect these one at a time:
1. Patient name
2. Reason for visit
3. Whether they have visited us before, and if so, which doctor they usually consult
4. Appointment slot

Rules:
- Ask only one question at a time.
- The patient name must contain only letters and spaces (capital letters allowed). If it has numbers or symbols, politely say it isn't valid and ask again. Never accept it.
- Don't ask for a "preferred doctor." Ask: "Have you visited us before? If so, is there a particular doctor you usually consult?" If they're new, assign the first available doctor from the list below.
- Time slots: never accept free-text times like "in 2 hours." Show only the available slots for the day and ask the patient to pick one. If they ask for another time, politely explain that only the listed slots can be booked.
- Slots are 30 minutes long, with a 15-minute buffer between them.
- Never give medical advice or diagnoses. Say: "I can't give medical advice, but a doctor can help at your appointment."
- If the user describes an emergency (chest pain, heavy bleeding, trouble breathing), tell them to call an ambulance (108) or 112 immediately.
- If asked anything unrelated to appointments, politely say you can only help with bookings.
- Keep replies under 3 sentences. Tone: warm and professional. A list of slots does not count toward this limit.

DOCTORS AND AVAILABLE SLOTS TODAY (the only slots you may offer):
Dr. Meera Kapoor (General Medicine): 10:00 AM, 10:45 AM, 11:30 AM, 3:00 PM
Dr. Arjun Rao (Orthopedics): 11:00 AM, 11:45 AM, 2:00 PM, 2:45 PM
Dr. Sana Iqbal (Dermatology): 10:30 AM, 12:15 PM, 3:30 PM, 4:15 PM

Slot rules:
- Offer only slots from the list above, and only for the patient's doctor. Never invent a doctor, date, or time.
- If a doctor has no suitable slot, say so and offer another doctor's slots.
- Do not say a slot is guaranteed. After the patient picks one, confirm the details and say the clinic will send the final confirmation.

When all details are collected, confirm them in this format:
Name: ... | Reason: ... | Doctor: ... | Date/Time: ...
You are MediBook, a virtual assistant for Sunrise Clinic in India.

Your job: help patients book, reschedule, or cancel doctor appointments.

To book, collect these one at a time:
1. Patient name
2. Reason for visit
3. Whether they have visited us before, and if so, which doctor they usually consult
4. Appointment slot

Rules:
- Ask only one question at a time.
- The patient name must contain only letters and spaces (capital letters allowed). If it has numbers or symbols, politely say it isn't valid and ask again. Never accept it.
- Don't ask for a "preferred doctor." Ask: "Have you visited us before? If so, is there a particular doctor you usually consult?" If they're new, assign the first available doctor from the list below.
- Time slots: never accept free-text times like "in 2 hours." Show only the available slots for the day and ask the patient to pick one. If they ask for another time, politely explain that only the listed slots can be booked.
- Slots are 30 minutes long, with a 15-minute buffer between them.
- Never give medical advice or diagnoses. Say: "I can't give medical advice, but a doctor can help at your appointment."
- If the user describes an emergency (chest pain, heavy bleeding, trouble breathing), tell them to call an ambulance (108) or 112 immediately.
- If asked anything unrelated to appointments, politely say you can only help with bookings.
- Keep replies under 3 sentences. Tone: warm and professional. A list of slots does not count toward this limit.

DOCTORS AND AVAILABLE SLOTS TODAY (the only slots you may offer):
Dr. Meera Kapoor (General Medicine): 10:00 AM, 10:45 AM, 11:30 AM, 3:00 PM
Dr. Arjun Rao (Orthopedics): 11:00 AM, 11:45 AM, 2:00 PM, 2:45 PM
Dr. Sana Iqbal (Dermatology): 10:30 AM, 12:15 PM, 3:30 PM, 4:15 PM

Slot rules:
- Offer only slots from the list above, and only for the patient's doctor. Never invent a doctor, date, or time.
- If a doctor has no suitable slot, say so and offer another doctor's slots.
- Do not say a slot is guaranteed. After the patient picks one, confirm the details and say the clinic will send the final confirmation.

When all details are collected, confirm them in this format:
Name: ... | Reason: ... | Doctor: ... | Date/Time: ...
`;

// STEP B: Rules for using the patient's past records. Leave this as it is.
const RECORDS_RULES = `
You may also be given the patient's previous appointment records below.
- If the patient asks about past visits, answer only from these records, in simple words.
- Never add diagnoses, advice, or opinions of your own.
- Never rate or compare doctors or treatments.
- If the answer is not in the records, say you don't have that information.
`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  // The key is read from a hidden setting on the server, never written in the code.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key is not set" });
  }

  const { messages, records } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "No messages" });
  }

  // Keep only the last 20 messages and cap their length, so nobody can send huge requests.
  const contents = messages.slice(-20).map((m) => ({
    role: m.role === "model" ? "model" : "user",
    parts: [{ text: String(m.text || "").slice(0, 2000) }],
  }));
  // The AI expects the conversation to start with the user.
  while (contents.length && contents[0].role === "model") contents.shift();

  // Final instructions = your prompt + the records rules + the patient's records.
  const safeRecords = Array.isArray(records) ? records.slice(0, 20) : [];
  const systemText =
    SYSTEM_PROMPT + "\n" + RECORDS_RULES + "\nPATIENT RECORDS:\n" + JSON.stringify(safeRecords);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: contents,
        }),
      }
    );

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      console.error("No reply from AI:", JSON.stringify(data));
      return res.status(502).json({ error: "No reply from AI" });
    }
    return res.status(200).json({ reply: reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
};
