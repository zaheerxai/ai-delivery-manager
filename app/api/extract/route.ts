import { NextRequest, NextResponse } from "next/server";

const GEMINI_MODEL = "gemini-2.0-flash";

export async function POST(req: NextRequest) {
  try {
    const { system, messages } = await req.json();

    const userContent = messages?.[0]?.content || "";

    // Gemini works best with a single merged prompt — keep system instructions
    // tightly bound to the user content, and explicitly repeat JSON-only instruction
    const prompt = [
      system,
      "---",
      "INPUT TEXT:",
      userContent,
      "---",
      "IMPORTANT: Your response must be ONLY a valid JSON array. No markdown, no backticks, no explanation. Start your response with [ and end with ].",
    ].join("\n\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
            // No responseMimeType — let Gemini return plain text so it
            // can produce a JSON array (mimeType forces object schema)
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini error:", JSON.stringify(data));
      return NextResponse.json(
        { error: data?.error?.message || "Gemini API error" },
        { status: response.status }
      );
    }

    // Extract text from Gemini response
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    // Strip any accidental markdown fences Gemini might still add
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    // Validate it's parseable — fall back to empty array if not
    try {
      JSON.parse(text);
    } catch {
      console.error("Gemini returned non-JSON:", text.slice(0, 300));
      text = "[]";
    }

    // Return in Anthropic-compatible shape so frontend needs zero changes
    return NextResponse.json({
      content: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("Route error:", err);
    return NextResponse.json(
      { error: "Proxy error: " + String(err) },
      { status: 500 }
    );
  }
}