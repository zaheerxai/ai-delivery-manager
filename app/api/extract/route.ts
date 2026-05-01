import { NextRequest, NextResponse } from "next/server";

const GEMINI_MODEL = "gemini-2.0-flash";

export async function POST(req: NextRequest) {
  try {
    const { system, messages } = await req.json();

    // Combine system prompt + user message into Gemini format
    const userContent = messages?.[0]?.content || "";
    const prompt = system ? `${system}\n\n---\n\n${userContent}` : userContent;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,          // low temp = consistent JSON
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data?.error?.message || "Gemini API error" },
        { status: response.status }
      );
    }

    // Translate Gemini response → Anthropic-compatible shape
    // so the frontend needs zero changes
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    return NextResponse.json({
      content: [{ type: "text", text }],
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Proxy error: " + String(err) },
      { status: 500 }
    );
  }
}