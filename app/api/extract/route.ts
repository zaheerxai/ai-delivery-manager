import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { text, prices, sellers, buyers } = await req.json();

    const deviceList = (prices || []).map((p: {device: string}) => p.device).join("\n");
    const sellerList = (sellers || []).map((s: {name: string}) => s.name).join(", ");
    const buyerList  = (buyers  || []).map((b: {name: string}) => b.name).join(", ");

    const prompt = `Extract mobile phone delivery parcels from the WhatsApp/text below.

DEVICE LIST (return EXACT name or empty string):
${deviceList}

SELLERS: ${sellerList}
BUYERS: ${buyerList}
DEFAULT BUYER: Shoaib
TODAY: ${new Date().toLocaleDateString("en-GB").replace(/\//g, "/").split("/").map((v,i)=>i===2?v.slice(-2):v).join("/")}

RULES:
1. Each WhatsApp timestamp like [4/29, 1:03 PM] starts a new parcel.
2. DATE: from timestamp [M/D] → format as M/D/YYYY (e.g. [4/29] → 4/29/2026).
3. SELLER: name after timestamp before colon → match to sellers list (e.g. "Talha Seller:" → "Talha").
4. TRACKING: code like LK817841390IE or 9-digit number.
5. DEVICE: match text to device list exactly. "Apple 17 pro max" = "IPhone 17 Pro Max 256gb". "S25FE" = "Samsung S25 FE 128gb".
6. BUYER: if address has "APARTMENT 157" or "D07KN36" → "Shoaib".
7. ADDRESS: full address on one line in UPPERCASE.

Return an array of objects matching this schema exactly:
[{"Date":"4/29/2026","Device":"IPhone 17 Pro Max 256gb","Buyer":"Shoaib","Seller":"Talha","Tracking":"LK817841390IE","Address":"APARTMENT 157 THE OLD DISTILLERY ANNE STREET NORTH DUBLIN 7 D07 KN36"}]

INPUT:
${text}`;

    // CHANGE 1: Switched to 1.5-flash to avoid the limit: 0 quota error on 2.0
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { 
            temperature: 0, 
            maxOutputTokens: 2048,
            // CHANGE 2: Force native JSON output
            responseMimeType: "application/json" 
          },
        }),
      }
    );

    const data = await resp.json();

    if (!resp.ok) {
      console.error("Gemini error:", JSON.stringify(data));
      // Added specific handling for the 429 quota error
      if (resp.status === 429) {
          return NextResponse.json({ error: "API Rate limit exceeded. Retrying shortly." }, { status: 429 });
      }
      return NextResponse.json({ error: data?.error?.message || "Gemini error" }, { status: 500 });
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    console.log("Gemini raw:", raw.slice(0, 500));

    // CHANGE 3: Simplified validation since responseMimeType guarantees JSON without markdown
    try { 
        JSON.parse(raw); 
    } catch {
        console.error("Invalid JSON from Gemini:", raw.slice(0, 300));
        return NextResponse.json({ error: "Failed to parse API response" }, { status: 500 });
    }

    return NextResponse.json({ content: [{ type: "text", text: raw }] });
  } catch (err) {
    console.error("Route error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}